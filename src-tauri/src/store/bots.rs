//! Bot definitions (`bots.json`) and each bot's home folder
//! (`bots/<id>/`: `ROLE.md`, `MEMORY.md`, `memory/`). A deleted bot's home
//! is moved to `trash/bots/<id>/` with its record beside it as `bot.json`,
//! never removed outright.
//!
//! Records are read one by one: a record this build cannot read is carried
//! through every save as it was written, and hides no other bot. A file this
//! build cannot read at all is refused and never overwritten.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bots::Bot;

pub const ROLE_FILE: &str = "ROLE.md";
pub const MEMORY_FILE: &str = "MEMORY.md";
pub const MEMORY_DIR: &str = "memory";
/// A trashed bot's record, so it can be restored with its name, settings and unknown fields.
pub const RECORD_FILE: &str = "bot.json";
/// The layout of `bots.json` this build writes.
pub const FILE_VERSION: u32 = 1;

static DEFINITION_WRITE_LOCK: Mutex<()> = Mutex::new(());
/// How many times this process saved `bots.json`, so a cached reading can tell it is stale (PRO-505).
static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// How many times this process saved the bots' definitions.
pub(crate) fn writes() -> u64 {
    WRITES.load(std::sync::atomic::Ordering::Acquire)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotFile {
    /// Kept as read: a newer build's number is not lowered.
    #[serde(default = "first_version")]
    version: u32,
    /// One more on every save, so a reader can tell which of two lists is newer.
    #[serde(default)]
    revision: u64,
    /// Each record as JSON, read one by one.
    #[serde(default)]
    bots: Vec<Value>,
    /// What a newer app keeps beside the list is written back as it was read.
    #[serde(flatten, default)]
    unknown: BTreeMap<String, Value>,
}

fn first_version() -> u32 {
    FILE_VERSION
}

impl Default for BotFile {
    fn default() -> Self {
        Self { version: FILE_VERSION, revision: 0, bots: Vec::new(), unknown: BTreeMap::new() }
    }
}

/// The bots as one read of `bots.json` has them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    pub revision: u64,
    pub bots: Vec<Bot>,
    /// Records this build cannot read, as they are in the file.
    pub unreadable: Vec<Value>,
}

fn definitions_path() -> Result<PathBuf> {
    Ok(super::root()?.join("bots.json"))
}

fn read() -> Result<BotFile> {
    let path = definitions_path()?;
    Ok(super::read_json::<BotFile>(&path)
        .with_context(|| format!("{} cannot be read; it is left as it is", path.display()))?
        .unwrap_or_default())
}

fn split(records: Vec<Value>) -> (Vec<Bot>, Vec<Value>) {
    let mut bots = Vec::new();
    let mut unreadable = Vec::new();
    for record in records {
        match serde_json::from_value::<Bot>(record.clone()) {
            Ok(bot) => bots.push(bot),
            Err(error) => {
                log::warn!("bots.json: a record this build cannot read is kept as it is: {error}");
                unreadable.push(record);
            }
        }
    }
    (bots, unreadable)
}

pub fn snapshot() -> Result<Snapshot> {
    let file = read()?;
    let (bots, unreadable) = split(file.bots);
    Ok(Snapshot { revision: file.revision, bots, unreadable })
}

pub fn list() -> Result<Vec<Bot>> {
    Ok(snapshot()?.bots)
}

pub fn get(id: &str) -> Result<Option<Bot>> {
    Ok(list()?.into_iter().find(|bot| bot.id == id))
}

/// Read, change and save the definitions as one step: nothing else writes
/// between the read and the save, and nothing is saved when `f` fails.
/// `announce` is told the saved list and its revision while the lock is still
/// held, so announcements leave in the order the changes were saved.
pub fn change<T>(f: impl FnOnce(&mut Vec<Bot>) -> Result<T>, announce: impl FnOnce(&Snapshot)) -> Result<T> {
    let _guard = DEFINITION_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut file = read()?;
    let (mut bots, unreadable) = split(std::mem::take(&mut file.bots));
    let out = f(&mut bots)?;
    file.bots = bots.iter().map(serde_json::to_value).collect::<Result<_, _>>()?;
    file.bots.extend(unreadable.iter().cloned());
    file.revision += 1;
    super::write_json(&definitions_path()?, &file)?;
    WRITES.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    announce(&Snapshot { revision: file.revision, bots, unreadable });
    Ok(out)
}

/// One bot's home folder. `id` is always one this store made (a UUID), read
/// back from `bots.json`; callers look the bot up before asking for its home.
pub fn home_dir(id: &str) -> Result<PathBuf> {
    anyhow::ensure!(valid_id(id), "invalid bot id");
    Ok(super::root()?.join("bots").join(id))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Make a new bot's home: its role, an empty memory file and the memory folder.
pub fn create_home(id: &str, role: &str, memory: &str) -> Result<PathBuf> {
    let home = super::ensure_dir(home_dir(id)?)?;
    super::ensure_dir(home.join(MEMORY_DIR))?;
    super::write_atomic(&home.join(ROLE_FILE), role.as_bytes())?;
    super::write_atomic(&home.join(MEMORY_FILE), memory.as_bytes())?;
    Ok(home)
}

pub fn read_role(id: &str) -> Result<String> {
    let path = home_dir(id)?.join(ROLE_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        // A home whose role file a person removed reads as an empty role.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

/// Only the tests write a role here: the app writes it through the bot's history (`bots::memory`).
#[cfg(test)]
pub fn write_role(id: &str, text: &str) -> Result<()> {
    let home = super::ensure_dir(home_dir(id)?)?;
    super::write_atomic(&home.join(ROLE_FILE), text.as_bytes())
}

/// Keep a bot's record in its home before the home goes to the trash. A
/// record whose id could name no home (a hand-edited one) has none to keep it in.
pub fn keep_record(bot: &Bot) -> Result<()> {
    if !valid_id(&bot.id) {
        return Ok(());
    }
    let home = super::ensure_dir(home_dir(&bot.id)?)?;
    super::write_json(&home.join(RECORD_FILE), bot)
}

fn trash_dir() -> Result<PathBuf> {
    super::ensure_dir(super::root()?.join("trash").join("bots"))
}

/// Move a bot's home to the trash and say where it went, or `None` when the
/// bot had no home to move (none left, or an id that could name none).
pub fn trash_home(id: &str) -> Result<Option<PathBuf>> {
    if !valid_id(id) {
        return Ok(None);
    }
    let home = home_dir(id)?;
    if !home.is_dir() {
        return Ok(None);
    }
    let trash = trash_dir()?;
    let mut target = trash.join(id);
    // An id is never reused, but a trashed home put back by hand and deleted again must not be lost.
    let mut copy = 2;
    while target.exists() {
        target = trash.join(format!("{id}-{copy}"));
        copy += 1;
    }
    std::fs::rename(&home, &target).with_context(|| format!("move {} to {}", home.display(), target.display()))?;
    Ok(Some(target))
}

/// Remove a home that was made for a bot whose definition was then not saved.
pub fn discard_home(home: &Path) {
    let _ = std::fs::remove_dir_all(home);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(id: &str) -> Bot {
        serde_json::from_value(serde_json::json!({
            "id": id, "slug": "atlas", "name": "Atlas", "roleTitle": "CTO", "roleTemplateId": "cto", "harness": "claude",
            "created": "2026-11-20T10:00:00Z", "modified": "2026-11-20T10:00:00Z",
        }))
        .unwrap()
    }

    fn quiet<T>(f: impl FnOnce(&mut Vec<Bot>) -> Result<T>) -> Result<T> {
        change(f, |_| {})
    }

    fn raw() -> Value {
        serde_json::from_str(&std::fs::read_to_string(definitions_path().unwrap()).unwrap()).unwrap()
    }

    #[test]
    fn definitions_round_trip_and_keep_what_they_do_not_know() {
        let _home = crate::store::temp_home();
        assert_eq!(snapshot().unwrap(), Snapshot::default());
        let first = bot("0198-a");
        quiet(|bots| {
            bots.push(first.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(list().unwrap(), vec![first.clone()]);
        assert_eq!(get("0198-a").unwrap(), Some(first));
        assert_eq!(get("0198-b").unwrap(), None);
        assert_eq!((raw()["version"].clone(), raw()["revision"].clone()), (serde_json::json!(1), serde_json::json!(1)));

        // A newer app's fields, on the file and on a bot (nested ones too), survive a change made by this one.
        let path = definitions_path().unwrap();
        let mut newer = raw();
        newer["version"] = serde_json::json!(3);
        newer["schema"] = serde_json::json!({"kind": "bots"});
        newer["bots"][0]["avatar"] = serde_json::json!({"colour": "teal"});
        newer["bots"][0]["paused"] = serde_json::json!({"at": "2026-11-20T11:00:00Z", "by": "owner", "source": "duty", "reason": "spend"});
        newer["bots"][0]["runsOn"] = serde_json::json!("cloudWorkspace");
        newer["bots"][0]["access"] = serde_json::json!("approveEverything");
        std::fs::write(&path, serde_json::to_vec(&newer).unwrap()).unwrap();
        let mut second = bot("0198-b");
        second.slug = "iris".into();
        quiet(|bots| {
            bots.push(second.clone());
            Ok(())
        })
        .unwrap();
        let saved = raw();
        assert_eq!(saved["version"], 3);
        assert_eq!(saved["revision"], 2);
        assert_eq!(saved["schema"], serde_json::json!({"kind": "bots"}));
        assert_eq!(saved["bots"][0], newer["bots"][0]);
        assert_eq!(list().unwrap().len(), 2);
    }

    #[test]
    fn a_record_this_build_cannot_read_hides_no_other_and_is_kept() {
        let _home = crate::store::temp_home();
        let good = serde_json::to_value(bot("0198-a")).unwrap();
        let bad = serde_json::json!({"id": 5, "name": ["not", "a", "name"]});
        std::fs::write(definitions_path().unwrap(), serde_json::to_vec(&serde_json::json!({"bots": [bad, good], "revision": 7})).unwrap()).unwrap();
        let read = snapshot().unwrap();
        assert_eq!((read.revision, read.bots.len(), read.unreadable.clone()), (7, 1, vec![bad.clone()]));
        quiet(|bots| {
            bots[0].name = "Iris".into();
            Ok(())
        })
        .unwrap();
        let saved = raw();
        assert_eq!(saved["bots"].as_array().unwrap().len(), 2);
        assert_eq!(saved["bots"][1], bad);
        assert_eq!(saved["bots"][0]["name"], "Iris");
        assert_eq!(saved["revision"], 8);
    }

    #[test]
    fn a_file_this_build_cannot_read_is_refused_and_never_overwritten() {
        let _home = crate::store::temp_home();
        for broken in ["{\"bots\": [", "{\"bots\": 5}", "[]"] {
            std::fs::write(definitions_path().unwrap(), broken).unwrap();
            assert!(snapshot().is_err() && list().is_err(), "{broken}");
            let mut announced = false;
            let refused = change(|bots| {
                bots.push(bot("0198-a"));
                Ok(())
            }, |_| announced = true);
            assert!(refused.unwrap_err().to_string().contains("left as it is"), "{broken}");
            assert!(!announced);
            assert_eq!(std::fs::read_to_string(definitions_path().unwrap()).unwrap(), broken);
        }
    }

    #[test]
    fn a_failed_change_saves_and_announces_nothing() {
        let _home = crate::store::temp_home();
        let mut announced = false;
        let result: Result<()> = change(|bots| {
            bots.push(bot("0198-a"));
            anyhow::bail!("no")
        }, |_| announced = true);
        assert!(result.is_err() && !announced);
        assert!(list().unwrap().is_empty());
        assert!(!definitions_path().unwrap().exists());
    }

    #[test]
    fn every_save_is_announced_with_the_next_revision() {
        let _home = crate::store::temp_home();
        let mut heard = Vec::new();
        for n in 0..3 {
            change(|bots| {
                bots.push(bot(&format!("0198-{n}")));
                Ok(())
            }, |saved| heard.push((saved.revision, saved.bots.len())))
            .unwrap();
        }
        assert_eq!(heard, [(1, 1), (2, 2), (3, 3)]);
        assert_eq!(snapshot().unwrap().revision, 3);
    }

    #[test]
    fn a_home_has_its_role_memory_and_memory_folder_and_goes_to_the_trash_whole() {
        let _home = crate::store::temp_home();
        let home = create_home("0198-a", "# Atlas\n", "# Memory\n").unwrap();
        assert_eq!(home, crate::store::root().unwrap().join("bots").join("0198-a"));
        assert_eq!(std::fs::read_to_string(home.join(ROLE_FILE)).unwrap(), "# Atlas\n");
        assert_eq!(std::fs::read_to_string(home.join(MEMORY_FILE)).unwrap(), "# Memory\n");
        assert!(home.join(MEMORY_DIR).is_dir());

        write_role("0198-a", "Lead the others.\n").unwrap();
        assert_eq!(read_role("0198-a").unwrap(), "Lead the others.\n");
        std::fs::write(home.join(MEMORY_DIR).join("note.md"), "kept").unwrap();
        keep_record(&bot("0198-a")).unwrap();

        let trashed = trash_home("0198-a").unwrap().unwrap();
        assert_eq!(trashed, crate::store::root().unwrap().join("trash").join("bots").join("0198-a"));
        assert!(!home.exists());
        assert_eq!(std::fs::read_to_string(trashed.join(ROLE_FILE)).unwrap(), "Lead the others.\n");
        assert_eq!(std::fs::read_to_string(trashed.join(MEMORY_DIR).join("note.md")).unwrap(), "kept");
        let kept: Bot = serde_json::from_str(&std::fs::read_to_string(trashed.join(RECORD_FILE)).unwrap()).unwrap();
        assert_eq!(kept, bot("0198-a"));
        // Nothing left to move the second time, and an earlier trashed home is not overwritten.
        assert_eq!(trash_home("0198-a").unwrap(), None);
        create_home("0198-a", "again", "").unwrap();
        assert_eq!(trash_home("0198-a").unwrap().unwrap(), crate::store::root().unwrap().join("trash").join("bots").join("0198-a-2"));
        assert_eq!(std::fs::read_to_string(trashed.join(ROLE_FILE)).unwrap(), "Lead the others.\n");
    }

    #[test]
    fn a_home_is_only_ever_inside_the_bots_folder() {
        let _home = crate::store::temp_home();
        for id in ["", "..", "../settings", "a/b", "a b"] {
            assert!(home_dir(id).is_err(), "{id:?}");
            assert!(read_role(id).is_err(), "{id:?}");
            // An id that could name no home has none to move or keep a record in.
            assert_eq!(trash_home(id).unwrap(), None, "{id:?}");
            assert!(keep_record(&bot(id)).is_ok(), "{id:?}");
        }
        assert!(!crate::store::root().unwrap().join("settings").exists());
        assert!(!crate::store::root().unwrap().join("trash").exists());
    }
}
