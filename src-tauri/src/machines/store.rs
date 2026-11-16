//! The machines this computer paired with: `machines.json` in the app's data
//! directory, one record per `machineId` (docs/MACHINES.md, "As built
//! (PRO-342)"). No credential: each device token is in the Keychain
//! (`secrets`). Rewritten under a cross-process lock; fields a newer build
//! wrote are kept.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::machine_wire::MachineOs;

const FILE: &str = "machines.json";
const LOCK: &str = "machines.lock";
const LOCK_WAIT: Duration = Duration::from_secs(10);

/// How the operating computer reaches a machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MachineRoute {
    RelayAndNearby,
    ThisNetwork,
}

/// One paired machine (`PairedMachine` in src/types/machines.ts).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedMachine {
    pub machine_id: String,
    pub name: String,
    pub os: MachineOs,
    pub version: String,
    /// The pinned host key, standard base64.
    pub public_key_b64: String,
    pub direct_endpoints: Vec<String>,
    pub route: MachineRoute,
    pub paired_at: i64,
    pub last_seen_at: Option<i64>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
struct File {
    v: u8,
    #[serde(default)]
    machines: Vec<PairedMachine>,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

impl Default for File {
    fn default() -> Self {
        Self { v: 1, machines: Vec::new(), other: Default::default() }
    }
}

pub struct MachineStore {
    path: PathBuf,
}

impl MachineStore {
    pub fn in_dir(dir: &Path) -> Self {
        Self { path: dir.join(FILE) }
    }

    /// `~/.raccoon/machines.json`.
    pub fn default_location() -> Result<Self> {
        Ok(Self::in_dir(&crate::store::root()?))
    }

    fn read(&self) -> Result<File> {
        match std::fs::read(&self.path) {
            Ok(bytes) => {
                let file: File = serde_json::from_slice(&bytes).with_context(|| format!("parse {}", self.path.display()))?;
                if file.v != 1 {
                    bail!("unsupported machines file version {}", file.v);
                }
                Ok(file)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(File::default()),
            Err(error) => Err(error).with_context(|| format!("read {}", self.path.display())),
        }
    }

    fn rewrite<T>(&self, change: impl FnOnce(&mut File) -> Result<T>) -> Result<T> {
        let dir = self.path.parent().context("machines path has no parent")?;
        std::fs::create_dir_all(dir)?;
        crate::store::transaction::run(&dir.join(LOCK), LOCK_WAIT, || {
            let mut file = self.read()?;
            let changed = change(&mut file)?;
            crate::cloud_bootstrap::write_durable(&self.path, &serde_json::to_vec_pretty(&file)?)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
            }
            Ok(changed)
        })
    }

    pub fn list(&self) -> Result<Vec<PairedMachine>> {
        Ok(self.read()?.machines)
    }

    pub fn get(&self, machine_id: &str) -> Result<Option<PairedMachine>> {
        Ok(self.read()?.machines.into_iter().find(|machine| machine.machine_id == machine_id))
    }

    /// Add or replace the machine with this `machineId`, keeping fields a
    /// newer build wrote on the record it replaces.
    pub fn put(&self, mut machine: PairedMachine) -> Result<PairedMachine> {
        self.rewrite(|file| {
            if let Some(index) = file.machines.iter().position(|existing| existing.machine_id == machine.machine_id) {
                let existing = file.machines.remove(index);
                for (key, value) in existing.other {
                    machine.other.entry(key).or_insert(value);
                }
            }
            file.machines.push(machine.clone());
            Ok(machine)
        })
    }

    /// Change how a machine is reached. `None` when it is not paired.
    pub fn set_route(&self, machine_id: &str, route: MachineRoute) -> Result<Option<PairedMachine>> {
        self.rewrite(|file| {
            let Some(machine) = file.machines.iter_mut().find(|machine| machine.machine_id == machine_id) else { return Ok(None) };
            machine.route = route;
            Ok(Some(machine.clone()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn machine(id: &str) -> PairedMachine {
        PairedMachine {
            machine_id: id.into(),
            name: "Mac mini".into(),
            os: MachineOs { family: "macos".into(), version: Some("26.1".into()) },
            version: "0.2.33".into(),
            public_key_b64: "AAAA".into(),
            direct_endpoints: vec!["ws://192.168.1.20:6768/machine/1".into()],
            route: MachineRoute::RelayAndNearby,
            paired_at: 1,
            last_seen_at: None,
            other: Default::default(),
        }
    }

    #[test]
    fn one_record_per_machine_in_the_documented_shape() {
        let dir = tempfile::tempdir().unwrap();
        let store = MachineStore::in_dir(dir.path());
        assert!(store.list().unwrap().is_empty());
        store.put(machine("m1")).unwrap();
        store.put(PairedMachine { name: "Studio".into(), ..machine("m1") }).unwrap();
        store.put(machine("m2")).unwrap();
        assert_eq!(store.list().unwrap().len(), 2, "pairing again replaces the record");
        assert_eq!(store.get("m1").unwrap().unwrap().name, "Studio");
        assert_eq!(store.set_route("m1", MachineRoute::ThisNetwork).unwrap().unwrap().route, MachineRoute::ThisNetwork);
        assert!(store.set_route("m3", MachineRoute::ThisNetwork).unwrap().is_none());
        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        let first = &written["machines"][0];
        assert_eq!(first["machineId"], "m1");
        assert_eq!(first["route"], "thisNetwork");
        assert_eq!(first["os"], json!({ "family": "macos", "version": "26.1" }));
        assert_eq!(first["lastSeenAt"], serde_json::Value::Null);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn fields_of_a_newer_build_survive() {
        let dir = tempfile::tempdir().unwrap();
        let store = MachineStore::in_dir(dir.path());
        let mut record = serde_json::to_value(machine("m1")).unwrap();
        record["futureField"] = json!(3);
        std::fs::write(dir.path().join(FILE), json!({ "v": 1, "machines": [record], "futureTop": true }).to_string()).unwrap();
        store.put(machine("m1")).unwrap();
        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(written["futureTop"], true);
        assert_eq!(written["machines"][0]["futureField"], 3);
        std::fs::write(dir.path().join(FILE), json!({ "v": 2 }).to_string()).unwrap();
        assert!(store.list().is_err());
    }
}
