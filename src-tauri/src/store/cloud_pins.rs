//! The cloud projects the reader pinned, per organization (#1403).
//!
//! A cloud project is pinned on this computer, not on the server: it was kept
//! in the window's preferences (`cloudPinned`), where only the window could
//! read it. It lives here so a paired phone reads and changes the same pins
//! as the sidebar. The window moves what its preferences held over once
//! ([`adopt`]), so no pin set before is lost.
//!
//! A project is named by its repository identity (`host/owner/name`), or
//! `blank/<name>` for a project with no repository, as the sidebar names it.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::transaction;

/// The event every window and phone hears when the pins change.
pub const CHANGED: &str = "cloud_pins_changed";

const TIMEOUT: Duration = Duration::from_secs(30);
/// What one organization may hold, and how long a name may be: a pin is a
/// reader's choice, never a list a client may grow without end.
const MOST_PER_ORG: usize = 500;
const LONGEST: usize = 512;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudPins {
    /// Pinned projects by organization id, in the order they were pinned.
    pub orgs: BTreeMap<String, Vec<String>>,
    /// The window's preferences were moved here: later ones are not read again.
    pub adopted: bool,
    /// Fields a newer build wrote, kept as they are.
    #[serde(flatten)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

fn file_path() -> Result<PathBuf> {
    Ok(super::root()?.join("cloud-pins.json"))
}

pub fn load() -> Result<CloudPins> {
    Ok(super::read_json(&file_path()?)?.unwrap_or_default())
}

fn update(f: impl FnOnce(&mut CloudPins) -> Result<()>) -> Result<CloudPins> {
    let path = file_path()?;
    transaction::run(&path.with_extension("lock"), TIMEOUT, || {
        let mut pins = load()?;
        f(&mut pins)?;
        pins.orgs.retain(|_, list| !list.is_empty());
        super::write_json(&path, &pins)?;
        Ok(pins)
    })
}

fn check(org_id: &str, identity: &str) -> Result<()> {
    let bad = |value: &str| value.trim().is_empty() || value.len() > LONGEST || value.chars().any(char::is_control);
    if bad(org_id) { bail!("The organization id is not valid."); }
    if bad(identity) { bail!("The cloud project is not valid."); }
    Ok(())
}

/// Pin or unpin one project. Pinning one already pinned, or unpinning one
/// that is not, changes nothing.
pub fn set(org_id: &str, identity: &str, pinned: bool) -> Result<CloudPins> {
    check(org_id, identity)?;
    update(|pins| {
        let list = pins.orgs.entry(org_id.to_string()).or_default();
        let present = list.iter().any(|entry| entry == identity);
        if pinned && !present {
            if list.len() >= MOST_PER_ORG { bail!("This organization has as many pinned projects as it can hold."); }
            list.push(identity.to_string());
        } else if !pinned && present {
            list.retain(|entry| entry != identity);
        }
        Ok(())
    })
}

/// Take in the pins the window's preferences held, once: the first call adds
/// them to what is here, and every later call changes nothing. The window
/// clears its own copy once this has answered.
pub fn adopt(window: BTreeMap<String, Vec<String>>) -> Result<CloudPins> {
    for (org_id, list) in &window {
        for identity in list { check(org_id, identity)?; }
    }
    update(|pins| {
        if pins.adopted { return Ok(()); }
        for (org_id, list) in window {
            let saved = pins.orgs.entry(org_id).or_default();
            for identity in list {
                if saved.len() < MOST_PER_ORG && !saved.contains(&identity) { saved.push(identity); }
            }
        }
        pins.adopted = true;
        Ok(())
    })
}

/// Forget the pins of these organizations: the account left them, as the
/// window forgets their other preferences.
pub fn forget_orgs(org_ids: &[String]) -> Result<CloudPins> {
    update(|pins| {
        pins.orgs.retain(|org_id, _| !org_ids.contains(org_id));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orgs(pins: &CloudPins) -> Vec<(String, Vec<String>)> {
        pins.orgs.clone().into_iter().collect()
    }

    #[test]
    fn cloud_pins_set_unset_and_are_kept_in_pin_order() {
        let _home = crate::store::temp_home();
        assert_eq!(load().unwrap(), CloudPins::default());
        set("org-1", "github.com/acme/web", true).unwrap();
        set("org-1", "blank/scratch", true).unwrap();
        // Pinned twice is pinned once.
        let pins = set("org-1", "github.com/acme/web", true).unwrap();
        assert_eq!(orgs(&pins), [("org-1".to_string(), vec!["github.com/acme/web".to_string(), "blank/scratch".to_string()])]);
        set("org-1", "github.com/acme/web", false).unwrap();
        let pins = set("org-1", "blank/scratch", false).unwrap();
        // An organization with nothing pinned is not kept.
        assert!(pins.orgs.is_empty());
        assert_eq!(load().unwrap(), pins);
        assert!(set("org-1", " ", true).is_err());
        assert!(set("", "github.com/acme/web", true).is_err());
    }

    #[test]
    fn cloud_pins_from_the_window_are_adopted_once() {
        let _home = crate::store::temp_home();
        set("org-1", "github.com/acme/api", true).unwrap();
        let window = BTreeMap::from([("org-1".to_string(), vec!["github.com/acme/web".to_string(), "github.com/acme/api".to_string()]), ("org-2".to_string(), vec!["blank/notes".to_string()])]);
        let pins = adopt(window.clone()).unwrap();
        assert!(pins.adopted);
        assert_eq!(pins.orgs["org-1"], ["github.com/acme/api", "github.com/acme/web"]);
        assert_eq!(pins.orgs["org-2"], ["blank/notes"]);
        // Unpinned here after the move, a pin the window still holds does not come back.
        set("org-2", "blank/notes", false).unwrap();
        let pins = adopt(window).unwrap();
        assert!(!pins.orgs.contains_key("org-2"));
        assert_eq!(forget_orgs(&["org-1".to_string()]).unwrap().orgs, BTreeMap::new());
    }
}
