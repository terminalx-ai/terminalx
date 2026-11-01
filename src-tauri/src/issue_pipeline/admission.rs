//! Serialize checkout admission with resolver reservations. A reservation is
//! persisted before the resolver's prompt is sent, and survives app restarts.
//!
//! Admission is one app-wide lock, so it is held only for short decisions:
//! whether a prompt may start a turn, and whether a checkout may be reserved
//! for local checks or conflict resolution (#727). Work that stops sessions
//! and then changes what they run in (removing a workspace, deleting or
//! moving a session, closing a tab) takes a [`Fence`] over just those
//! sessions instead, and does its slow part (network, folder walks, deletion)
//! behind it. A prompt for any other tab never waits on that work.
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};
use anyhow::{bail, Result};
use crate::store::index;

static ADMISSION: Mutex<()> = Mutex::new(());

thread_local! {
    /// Whether this thread holds admission: a fence taken under it needs no
    /// barrier, and waiting for one would never end.
    static HELD: Cell<bool> = const { Cell::new(false) };
}

/// Checkout admission, held by this thread until it is dropped.
pub struct Admitted {
    _guard: MutexGuard<'static, ()>,
}

impl Drop for Admitted {
    fn drop(&mut self) {
        HELD.with(|held| held.set(false));
    }
}

pub fn lock() -> Admitted {
    #[cfg(test)]
    BEFORE_LOCK.with(|hook| { let next = hook.borrow_mut().take(); if let Some(next) = next { next(); } });
    let guard = ADMISSION.lock().unwrap_or_else(|error| error.into_inner());
    HELD.with(|held| held.set(true));
    #[cfg(test)]
    AFTER_LOCK.with(|hook| { let next = hook.borrow_mut().take(); if let Some(next) = next { next(); } });
    Admitted { _guard: guard }
}

/// Admission for a prompt or start in one tab. A tab whose agent is being
/// stopped behind a [`Kind::Hold`] fence is waited for first, without
/// holding admission, so every other tab is admitted meanwhile.
pub fn lock_for(session_id: &str, tab_id: &str) -> Admitted {
    loop {
        {
            let mut fences = FENCES.lock().unwrap_or_else(|error| error.into_inner());
            while fences.iter().any(|fence| fence.holds(session_id, tab_id)) {
                fences = LIFTED.wait(fences).unwrap_or_else(|error| error.into_inner());
            }
        }
        let admitted = lock();
        // A hold taken between the look and the lock is waiting for this
        // thread at its barrier: let it go first.
        if !FENCES.lock().unwrap_or_else(|error| error.into_inner()).iter().any(|fence| fence.holds(session_id, tab_id)) {
            return admitted;
        }
    }
}

#[cfg(test)]
thread_local! {
    static BEFORE_LOCK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static AFTER_LOCK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

/// One-shot, thread-local barriers for process-bounded lock-order regressions.
#[cfg(test)]
pub(crate) fn observe_next_lock(before: Option<Box<dyn FnOnce()>>, after: Option<Box<dyn FnOnce()>>) {
    BEFORE_LOCK.with(|hook| *hook.borrow_mut() = before);
    AFTER_LOCK.with(|hook| *hook.borrow_mut() = after);
}

/// What a fence closes to new turns and starts.
#[derive(Debug, Clone)]
pub enum Scope {
    /// Every tab of a session.
    Session(String),
    /// One tab.
    Tab(String, String),
    /// Every session that runs in this checkout or a folder inside it.
    Checkout(PathBuf),
}

impl Scope {
    pub fn checkout(path: impl AsRef<Path>) -> Self {
        Self::Checkout(canonical(path.as_ref()))
    }
}

/// What a prompt that meets a fence is told, or that it waits.
#[derive(Debug, Clone, Copy)]
pub enum Kind {
    /// Refused with this reason: what the fence is for ends the session's
    /// place (its workspace, its folder, the session or the tab itself).
    Refuse(&'static str),
    /// Held until the fence is lifted, then admitted as usual: the tab's
    /// agent is only being stopped, and a prompt starts it again.
    Hold,
}

pub const WORKSPACE_REMOVED: &str = "This workspace is being removed. Nothing was sent.";
pub const SESSION_DELETED: &str = "This session is being deleted. Nothing was sent.";
pub const SESSION_MOVED: &str = "This conversation is moving to another folder. Send it again once it has moved.";
pub const TAB_CLOSED: &str = "This tab is closing. Nothing was sent.";
const STOPPING: &str = "This tab's agent is being stopped. Send it again in a moment.";

struct Entry {
    id: u64,
    scope: Scope,
    kind: Kind,
}

impl Entry {
    fn holds(&self, session_id: &str, tab_id: &str) -> bool {
        matches!(self.kind, Kind::Hold) && match &self.scope {
            Scope::Session(id) => id == session_id,
            Scope::Tab(id, tab) => id == session_id && tab == tab_id,
            Scope::Checkout(_) => false,
        }
    }

    fn covers(&self, session_id: &str, tab_id: Option<&str>, cwd: &mut dyn FnMut() -> Option<PathBuf>) -> bool {
        match &self.scope {
            Scope::Session(id) => id == session_id,
            Scope::Tab(id, tab) => id == session_id && tab_id.is_some_and(|tab_id| tab == tab_id),
            Scope::Checkout(path) => cwd().is_some_and(|cwd| cwd.starts_with(path)),
        }
    }
}

static FENCES: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
static LIFTED: Condvar = Condvar::new();
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Sessions, tabs or a checkout closed to new turns and agent starts until
/// this is dropped. Fences nest: the same scope may be fenced twice.
#[must_use = "the fence lifts when it is dropped"]
pub struct Fence {
    ids: Vec<u64>,
}

impl Drop for Fence {
    fn drop(&mut self) {
        if self.ids.is_empty() { return; }
        FENCES.lock().unwrap_or_else(|error| error.into_inner()).retain(|entry| !self.ids.contains(&entry.id));
        LIFTED.notify_all();
    }
}

/// Fence `scopes`. When this returns, a prompt admitted before it has
/// finished, so its turn is visible to a look at the session, and every
/// prompt admitted after it meets the fence. Taking admission for that
/// moment is the only wait: the fenced work itself runs without it.
pub fn fence(kind: Kind, scopes: impl IntoIterator<Item = Scope>) -> Fence {
    let ids: Vec<u64> = {
        let mut fences = FENCES.lock().unwrap_or_else(|error| error.into_inner());
        scopes.into_iter().map(|scope| {
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            fences.push(Entry { id, scope, kind });
            id
        }).collect()
    };
    if !ids.is_empty() && !HELD.with(Cell::get) {
        // Taken and given back at once. A test's one-shot hook on this thread
        // holds the fenced work here, at the moment it is admitted.
        drop(lock());
    }
    Fence { ids }
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Refused when a fence covers the session, or the tab when one is named.
/// Starts that are not prompts (a tab opened, a shell) are held to this.
pub fn open(session_id: &str, tab_id: Option<&str>) -> Result<()> {
    // Copied out, so the index is not read with the fences locked.
    let fences: Vec<Entry> = FENCES.lock().unwrap_or_else(|error| error.into_inner()).iter()
        .map(|entry| Entry { id: entry.id, scope: entry.scope.clone(), kind: entry.kind }).collect();
    if fences.is_empty() { return Ok(()); }
    // Read once, and only for a checkout fence: a session the index does not
    // hold yet runs in no fenced checkout.
    let mut known: Option<Option<PathBuf>> = None;
    let mut cwd = || known.get_or_insert_with(|| index::get(session_id).ok().map(|session| canonical(Path::new(&session.cwd)))).clone();
    for entry in &fences {
        if entry.covers(session_id, tab_id, &mut cwd) {
            match entry.kind {
                Kind::Refuse(reason) => bail!(reason),
                Kind::Hold => bail!(STOPPING),
            }
        }
    }
    Ok(())
}

fn same_checkout(a: &str, b: &str) -> bool {
    let normalized = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
    normalized(a) == normalized(b)
}

/// Called under the admission lock before dispatching a new prompt.
pub fn check(session_id: &str, tab_id: &str) -> Result<()> {
    open(session_id, Some(tab_id))?;
    let reservations: Vec<_> = super::store::list()?.into_iter()
        .filter(|pipeline| pipeline.checking_locally || pipeline.resolution.is_some()).collect();
    // Ordinary hooks also serve live conversations before index persistence.
    // There is no checkout restriction to enforce without a reservation.
    if reservations.is_empty() { return Ok(()); }
    let session = index::get(session_id)?;
    for pipeline in reservations {
        if pipeline.checking_locally && same_checkout(&index::get(&pipeline.author.session_id)?.cwd, &session.cwd) {
            bail!("TerminalX is running checks on this checkout. Wait for them to finish before starting another turn.");
        }
        if pipeline.resolution.is_none() { continue; }
        let Some(resolver) = pipeline.resolver.as_ref() else { continue };
        if resolver.session_id == session_id && resolver.tab_id == tab_id { continue; }
        let owner = index::get(&pipeline.author.session_id)?;
        if same_checkout(&owner.cwd, &session.cwd) {
            bail!("This checkout is reserved for conflict resolution. Wait for the resolver to finish before starting another turn.");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issue_pipeline::{Pipeline, Resolution, SessionRef, Stage};
    use std::time::Duration;

    #[test]
    fn no_reservation_leaves_unindexed_live_conversations_alone() {
        let _home = crate::store::temp_home();
        assert!(check("live-before-index", "t1").is_ok());
    }

    fn session(id: &str, cwd: &str) -> index::SessionEntry {
        serde_json::from_value(serde_json::json!({
            "id": id, "projectPath": "/repo", "cwd": cwd, "title": id,
            "created": "2026-10-24T00:00:00Z", "modified": "2026-10-24T00:00:00Z",
            "tabs": [{"id":"t1", "harness":"claude", "created":"2026-10-24T00:00:00Z"}]
        })).unwrap()
    }

    #[test]
    fn a_reservation_excludes_other_conversations_but_allows_its_resolver() {
        let _home = crate::store::temp_home();
        index::save(&[session("author", "/checkout"), session("other", "/checkout"), session("elsewhere", "/another")]).unwrap();
        let mut pipeline: Pipeline = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
        pipeline.author = SessionRef { session_id: "author".into(), tab_id: "t1".into() };
        pipeline.resolver = Some(SessionRef { session_id: "author".into(), tab_id: "resolver".into() });
        pipeline.resolution = Some(Resolution { head: "head".into(), remote_head: None, base: "main".into(), base_commit: "base".into(), return_stage: Stage::Work });
        super::super::store::insert(&pipeline).unwrap();
        assert!(check("author", "t1").is_err());
        assert!(check("other", "t1").is_err());
        assert!(check("author", "resolver").is_ok());
        assert!(check("elsewhere", "t1").is_ok());
        pipeline.resolution = None;
        pipeline.checking_locally = true;
        super::super::store::commit(&mut pipeline).unwrap();
        assert!(check("author", "resolver").is_err());
        pipeline.checking_locally = false;
        super::super::store::commit(&mut pipeline).unwrap();
        assert!(check("other", "t1").is_ok());
    }

    /// A fence refuses only what it covers: the session, the tab, or every
    /// session in the checkout and the folders inside it.
    #[test]
    fn a_fence_refuses_what_it_covers_and_nothing_else() {
        let _home = crate::store::temp_home();
        let checkout = tempfile::tempdir().unwrap();
        let inside = checkout.path().join("src");
        std::fs::create_dir(&inside).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        index::save(&[
            session("in", checkout.path().to_str().unwrap()),
            session("below", inside.to_str().unwrap()),
            session("out", elsewhere.path().to_str().unwrap()),
        ]).unwrap();
        {
            let _fence = fence(Kind::Refuse(WORKSPACE_REMOVED), [Scope::checkout(checkout.path())]);
            assert_eq!(check("in", "t1").unwrap_err().to_string(), WORKSPACE_REMOVED);
            assert!(check("below", "t1").is_err());
            assert!(open("in", None).is_err(), "a shell or a tab opened there is refused too");
            assert!(check("out", "t1").is_ok());
            assert!(check("not-indexed", "t1").is_ok());
        }
        assert!(check("in", "t1").is_ok(), "lifted when dropped");
        {
            let _fence = fence(Kind::Refuse(TAB_CLOSED), [Scope::Tab("in".into(), "t1".into())]);
            assert!(check("in", "t1").is_err());
            assert!(check("in", "t2").is_ok());
            assert!(open("in", None).is_ok(), "the session's shell is not the tab");
        }
        let outer = fence(Kind::Refuse(SESSION_DELETED), [Scope::Session("out".into())]);
        let inner = fence(Kind::Refuse(SESSION_DELETED), [Scope::Session("out".into())]);
        drop(inner);
        assert!(check("out", "t1").is_err(), "fences nest");
        drop(outer);
        assert!(check("out", "t1").is_ok());
    }

    /// Taking a fence waits for the prompt being admitted at that moment, so
    /// what the fenced work looks at next includes its turn. It is also safe
    /// under admission, where that wait would never end.
    #[test]
    fn a_fence_waits_for_the_prompt_being_admitted_and_nests_under_admission() {
        let admitted = lock();
        let (taken_tx, taken_rx) = std::sync::mpsc::channel();
        let fencing = std::thread::spawn(move || {
            let fence = fence(Kind::Refuse(SESSION_DELETED), [Scope::Session("s".into())]);
            taken_tx.send(()).unwrap();
            drop(fence);
        });
        assert!(taken_rx.recv_timeout(Duration::from_millis(200)).is_err(), "the fence waits for the admitted prompt");
        let nested = fence(Kind::Refuse(SESSION_DELETED), [Scope::Session("t".into())]);
        drop(nested);
        drop(admitted);
        taken_rx.recv_timeout(Duration::from_secs(5)).expect("the fence is taken once the prompt is through");
        fencing.join().unwrap();
    }

    /// A tab whose agent is being stopped holds its own prompts until the
    /// stop is over, and admits every other tab meanwhile.
    #[test]
    fn a_hold_waits_for_its_tab_only() {
        let hold = fence(Kind::Hold, [Scope::Tab("held".into(), "t1".into())]);
        drop(lock_for("held", "t2"));
        drop(lock_for("other", "t1"));
        let (admitted_tx, admitted_rx) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            let admitted = lock_for("held", "t1");
            admitted_tx.send(()).unwrap();
            drop(admitted);
        });
        assert!(admitted_rx.recv_timeout(Duration::from_millis(200)).is_err(), "held while the fence stands");
        drop(lock_for("other", "t1"));
        drop(hold);
        admitted_rx.recv_timeout(Duration::from_secs(5)).expect("admitted once the fence is lifted");
        waiting.join().unwrap();
    }
}
