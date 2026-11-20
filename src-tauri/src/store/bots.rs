//! Bot definitions (`bots.json`) and each bot's home folder
//! (`bots/<id>/`: `ROLE.md`, `MEMORY.md`, `memory/`). A deleted bot's home
//! is moved to `trash/bots/<id>/`, never removed outright.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::bots::Bot;

pub const ROLE_FILE: &str = "ROLE.md";
pub const MEMORY_FILE: &str = "MEMORY.md";
pub const MEMORY_DIR: &str = "memory";

static DEFINITION_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotFile {
    #[serde(default)]
    bots: Vec<Bot>,
    /// What a newer app keeps beside the list is written back as it was read.
    #[serde(flatten, default)]
    unknown: std::collections::BTreeMap<String, serde_json::Value>,
}

fn definitions_path() -> Result<PathBuf> {
    Ok(super::root()?.join("bots.json"))
}

fn read() -> Result<BotFile> {
    Ok(super::read_json::<BotFile>(&definitions_path()?)?.unwrap_or_default())
}

pub fn list() -> Result<Vec<Bot>> {
    Ok(read()?.bots)
}

pub fn get(id: &str) -> Result<Bot> {
    list()?.into_iter().find(|bot| bot.id == id).ok_or_else(|| anyhow::anyhow!("bot {id} not found"))
}

/// Read, change and save the definitions as one step: nothing else writes
/// between the read and the save, and nothing is saved when `f` fails.
pub fn change<T>(f: impl FnOnce(&mut Vec<Bot>) -> Result<T>) -> Result<T> {
    let _guard = DEFINITION_WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut file = read()?;
    let out = f(&mut file.bots)?;
    super::write_json(&definitions_path()?, &file)?;
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

pub fn write_role(id: &str, text: &str) -> Result<()> {
    let home = super::ensure_dir(home_dir(id)?)?;
    super::write_atomic(&home.join(ROLE_FILE), text.as_bytes())
}

fn trash_dir() -> Result<PathBuf> {
    super::ensure_dir(super::root()?.join("trash").join("bots"))
}

/// Move a bot's home to the trash and say where it went, or `None` when the
/// bot had no home left to move.
pub fn trash_home(id: &str) -> Result<Option<PathBuf>> {
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

    #[test]
    fn definitions_round_trip_and_keep_what_they_do_not_know() {
        let _home = crate::store::temp_home();
        assert!(list().unwrap().is_empty());
        let first = bot("0198-a");
        change(|bots| {
            bots.push(first.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(list().unwrap(), vec![first.clone()]);
        assert_eq!(get("0198-a").unwrap(), first);
        assert!(get("0198-b").is_err());

        // A newer app's fields, on the file and on a bot, survive a change made by this one.
        let path = definitions_path().unwrap();
        let mut raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        raw["schema"] = serde_json::json!(2);
        raw["bots"][0]["avatar"] = serde_json::json!({"colour": "teal"});
        std::fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
        change(|bots| {
            bots[0].name = "Iris".into();
            Ok(())
        })
        .unwrap();
        let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["schema"], 2);
        assert_eq!(saved["bots"][0]["avatar"], serde_json::json!({"colour": "teal"}));
        assert_eq!(saved["bots"][0]["name"], "Iris");
    }

    #[test]
    fn a_failed_change_saves_nothing() {
        let _home = crate::store::temp_home();
        let result: Result<()> = change(|bots| {
            bots.push(bot("0198-a"));
            anyhow::bail!("no")
        });
        assert!(result.is_err());
        assert!(list().unwrap().is_empty());
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

        let trashed = trash_home("0198-a").unwrap().unwrap();
        assert_eq!(trashed, crate::store::root().unwrap().join("trash").join("bots").join("0198-a"));
        assert!(!home.exists());
        assert_eq!(std::fs::read_to_string(trashed.join(ROLE_FILE)).unwrap(), "Lead the others.\n");
        assert_eq!(std::fs::read_to_string(trashed.join(MEMORY_DIR).join("note.md")).unwrap(), "kept");
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
        }
    }
}
