//! Private, short-lived immutable history downloads. A conversation (or even
//! one event) can exceed an IPC frame; only bounded byte chunks cross control.
use std::{collections::HashMap, fs::File, io::{Read, Seek, SeekFrom}, sync::Mutex, time::{Duration, Instant}};
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use crate::events::AgentEvent;

const CHUNK: usize = 256 * 1024;
const SLOTS: usize = 4;
const TTL: Duration = Duration::from_secs(120);
struct Snapshot { session: String, tab: String, file: Option<File>, size: u64, expires: Instant }
#[derive(Default)]
pub(crate) struct Downloads(Mutex<HashMap<String, Snapshot>>);
// Preparation is executing outside the registry lock. Its capacity cannot be
// reclaimed by a download TTL (or an unwinding loader) while work is still live.
struct Preparation<'a> { downloads: &'a Downloads, token: &'a str }
impl Drop for Preparation<'_> {
    fn drop(&mut self) {
        let mut all = self.downloads.0.lock().unwrap();
        if all.get(self.token).is_some_and(|entry| entry.file.is_none()) {
            all.remove(self.token);
        }
    }
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Opened { pub token: String, pub size: u64 }
#[derive(Serialize, Deserialize)]
pub(crate) struct Chunk { pub offset: u64, pub data: String }
impl Downloads {
    pub fn reap(&self) { self.0.lock().unwrap().retain(|_, entry| entry.file.is_none() || entry.expires > Instant::now()); }
    pub fn open(&self, session: &str, tab: &str, load: impl FnOnce() -> Result<Vec<AgentEvent>>) -> Result<Opened> {
        let token = uuid::Uuid::new_v4().to_string();
        {
            let mut all = self.0.lock().unwrap();
            all.retain(|_, entry| entry.file.is_none() || entry.expires > Instant::now());
            if all.len() >= SLOTS { bail!("Too many history downloads; retry after the current reads finish."); }
            all.insert(token.clone(), Snapshot { session: session.into(), tab: tab.into(), file: None, size: 0, expires: Instant::now() + TTL });
        }
        // No registry/runtime lock across canonical reconciliation or file I/O.
        // Anonymous owner-only tempfile is removed even on error/owner crash.
        let _preparation = Preparation { downloads: self, token: &token };
        (|| {
            let mut file = tempfile::tempfile()?;
            serde_json::to_writer(&mut file, &load()?)?;
            let size = file.metadata()?.len();
            let mut all = self.0.lock().unwrap();
            let entry = all.get_mut(&token).context("History download expired while preparing it.")?;
            entry.file = Some(file); entry.size = size; entry.expires = Instant::now() + TTL;
            Ok(Opened { token: token.clone(), size })
        })()
    }
    pub fn chunk(&self, session: &str, tab: &str, token: &str, offset: u64) -> Result<Chunk> {
        let mut all = self.0.lock().unwrap();
        all.retain(|_, entry| entry.file.is_none() || entry.expires > Instant::now());
        let entry = all.get_mut(token).context("History download expired or belongs to another owner.")?;
        if entry.session != session || entry.tab != tab { bail!("History download scope does not match."); }
        if offset > entry.size { bail!("History offset exceeds snapshot."); }
        let file = entry.file.as_mut().context("History download is still being prepared.")?;
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; (CHUNK as u64).min(entry.size - offset) as usize];
        file.read_exact(&mut bytes)?;
        entry.expires = Instant::now() + TTL;
        Ok(Chunk { offset, data: base64::engine::general_purpose::STANDARD.encode(bytes) })
    }
    pub fn close(&self, session: &str, tab: &str, token: &str) -> Result<()> {
        let mut all = self.0.lock().unwrap();
        if let Some(entry) = all.get(token) {
            if entry.session != session || entry.tab != tab { bail!("History download scope does not match."); }
            if entry.file.is_none() { bail!("History download is still being prepared."); }
        }
        all.remove(token);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparing_downloads_keep_capacity_across_expiry_until_load_finishes() {
        use std::sync::{mpsc, Arc};
        let downloads = Arc::new(Downloads::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let mut workers = Vec::new();
        let mut releases = Vec::new();
        for _ in 0..SLOTS {
            let downloads = downloads.clone();
            let entered = entered_tx.clone();
            let (release, wait) = mpsc::channel();
            releases.push(release);
            workers.push(std::thread::spawn(move || downloads.open("s", "t", || {
                entered.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5))?;
                Ok(vec![])
            })));
        }
        // Each callback is now executing outside the registry lock. Expire the
        // stored deadlines without sleeping for TTL or cancelling those loads.
        let entered = (0..SLOTS).all(|_| entered_rx.recv_timeout(Duration::from_secs(5)).is_ok());
        let tokens = {
            let mut all = downloads.0.lock().unwrap();
            for entry in all.values_mut() { entry.expires = Instant::now(); }
            all.keys().cloned().collect::<Vec<_>>()
        };
        downloads.reap();
        let token = tokens.first().cloned().unwrap_or_default();
        let chunk_error = downloads.chunk("s", "t", &token, 0).err().map(|error| error.to_string()).unwrap_or_default();
        let fifth = downloads.open("s", "t", || Ok(vec![]));
        let close_preparing = downloads.close("s", "t", &token);
        // Always release/join before assertions: the old eviction behavior must
        // fail the bound without leaving blocked workers behind.
        for release in releases { let _ = release.send(()); }
        let completed = workers.into_iter().map(|worker| worker.join()).collect::<Vec<_>>();
        assert!(entered);
        assert!(fifth.is_err(), "expiry admitted an additional load while four were executing");
        assert!(close_preparing.is_err());
        assert!(chunk_error.contains("still being prepared"));
        assert!(completed.into_iter().all(|result| result.unwrap().is_ok()));
        assert_eq!(downloads.0.lock().unwrap().len(), SLOTS);
        // Only ready snapshots may expire and make room for a subsequent load.
        for entry in downloads.0.lock().unwrap().values_mut() { entry.expires = Instant::now(); }
        downloads.reap();
        assert!(downloads.open("s", "t", || Ok(vec![])).is_ok());
    }

    #[test]
    fn a_panicking_preparation_releases_its_slot() {
        let downloads = Downloads::default();
        assert!(std::panic::catch_unwind(|| downloads.open("s", "t", || panic!("loader failed"))).is_err());
        assert!(downloads.0.lock().unwrap().is_empty());
        assert!(downloads.open("s", "t", || Ok(vec![])).is_ok());
    }

    #[test]
    fn snapshot_does_not_follow_source_changes() {
        let downloads = Downloads::default();
        let mut source = b"[]".to_vec();
        let first = downloads.open("s", "t", || Ok(serde_json::from_slice(&source)?)).unwrap();
        source.clear(); // Subsequent source reads now fail, the snapshot must not.
        assert!(downloads.open("s", "t", || Ok(serde_json::from_slice(&source)?)).is_err());
        assert_eq!(downloads.chunk("s", "t", &first.token, 0).unwrap().data, "W10=");
    }

    #[test]
    fn downloads_are_scoped_expire_and_release_slots_after_errors() {
        let downloads = Downloads::default();
        assert!(downloads.open("s", "t", || bail!("read failed")).is_err());
        let first = downloads.open("s", "t", || Ok(vec![])).unwrap();
        assert!(downloads.chunk("other", "t", &first.token, 0).is_err());
        assert!(downloads.close("s", "other", &first.token).is_err());
        assert!(downloads.chunk("s", "t", &first.token, first.size + 1).is_err());
        assert_eq!(downloads.chunk("s", "t", &first.token, 0).unwrap().data, "W10=");
        for _ in 1..SLOTS { downloads.open("s", "t", || Ok(vec![])).unwrap(); }
        assert!(downloads.open("s", "t", || panic!("no unbounded concurrent load")).is_err());
        downloads.0.lock().unwrap().get_mut(&first.token).unwrap().expires = Instant::now();
        assert!(downloads.chunk("s", "t", &first.token, 0).is_err());
        let next = downloads.open("s", "t", || Ok(vec![])).unwrap();
        downloads.close("s", "t", &next.token).unwrap();
        assert!(downloads.chunk("s", "t", &next.token, 0).is_err());
    }
}
