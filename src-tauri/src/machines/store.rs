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
pub use crate::remote::machine_client::MachineRoute;
use crate::remote::machine_client::{RelayInfo, RouteUsed};

const FILE: &str = "machines.json";
const LOCK: &str = "machines.lock";
const LOCK_WAIT: Duration = Duration::from_secs(10);

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
    /// The route that last worked; null before the first connection (PRO-345).
    #[serde(default)]
    pub last_route: Option<RouteUsed>,
    /// Where this computer reaches the machine through the relay, for the
    /// account in `userId`; null without a relay credential. Never the
    /// credential, which is in the Keychain (`relay:<machineId>`).
    #[serde(default)]
    pub relay: Option<RelayInfo>,
    /// Renamed on this computer (PRO-350): `name` is this computer's, and
    /// the name the machine describes itself with no longer replaces it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub named_here: bool,
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

    /// Change a machine's record. `None` when it is not paired.
    pub fn update(&self, machine_id: &str, change: impl FnOnce(&mut PairedMachine)) -> Result<Option<PairedMachine>> {
        self.rewrite(|file| {
            let Some(machine) = file.machines.iter_mut().find(|machine| machine.machine_id == machine_id) else { return Ok(None) };
            change(machine);
            Ok(Some(machine.clone()))
        })
    }

    /// Forget a machine (Settings → Machines → Remove). The record it had,
    /// or `None` when it was not paired. Its sessions stay on the machine.
    pub fn remove(&self, machine_id: &str) -> Result<Option<PairedMachine>> {
        self.rewrite(|file| {
            let Some(index) = file.machines.iter().position(|machine| machine.machine_id == machine_id) else { return Ok(None) };
            Ok(Some(file.machines.remove(index)))
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
            last_route: None,
            relay: None,
            named_here: false,
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
        assert_eq!(first["lastRoute"], serde_json::Value::Null);
        assert_eq!(first["relay"], serde_json::Value::Null);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn removing_a_machine_drops_only_its_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = MachineStore::in_dir(dir.path());
        store.put(machine("m1")).unwrap();
        store.put(machine("m2")).unwrap();
        assert_eq!(store.remove("m1").unwrap().unwrap().machine_id, "m1");
        assert!(store.remove("m1").unwrap().is_none(), "already gone");
        assert_eq!(store.list().unwrap().iter().map(|machine| machine.machine_id.as_str()).collect::<Vec<_>>(), vec!["m2"]);
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

#[cfg(test)]
pub(crate) mod tests_support {
    pub(crate) use super::tests::machine;
}

#[cfg(test)]
mod connection_fields_tests {
    use super::*;
    use crate::remote::machine_client::RouteKind;
    use serde_json::json;

    #[test]
    fn the_last_route_and_relay_place_are_kept_and_a_pre_pro_345_record_reads() {
        let dir = tempfile::tempdir().unwrap();
        let store = MachineStore::in_dir(dir.path());
        // A record PRO-342 wrote has neither field.
        std::fs::write(
            dir.path().join(FILE),
            json!({ "v": 1, "machines": [{ "machineId": "m1", "name": "Mac mini", "os": { "family": "macos", "version": null }, "version": "0.2.33",
                "publicKeyB64": "AAAA", "directEndpoints": [], "route": "relayAndNearby", "pairedAt": 1, "lastSeenAt": null }] })
            .to_string(),
        )
        .unwrap();
        assert_eq!(store.get("m1").unwrap().unwrap().last_route, None);
        let relay = RelayInfo { director_url: "https://d".into(), cell_url: "https://c".into(), assignment_epoch: 2, relay_host_id: "m1".into(), relay_device_id: "computer-1".into(), user_id: "user-1".into() };
        store
            .update("m1", |machine| {
                machine.last_route = Some(RouteUsed { kind: RouteKind::Tailscale, endpoint: Some("ws://100.64.0.2:6768/machine/1".into()) });
                machine.relay = Some(relay.clone());
            })
            .unwrap()
            .unwrap();
        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(written["machines"][0]["lastRoute"], json!({ "kind": "tailscale", "endpoint": "ws://100.64.0.2:6768/machine/1" }));
        assert_eq!(
            written["machines"][0]["relay"],
            json!({ "directorUrl": "https://d", "cellUrl": "https://c", "assignmentEpoch": 2, "relayHostId": "m1", "relayDeviceId": "computer-1", "userId": "user-1" })
        );
        assert!(!String::from_utf8(std::fs::read(dir.path().join(FILE)).unwrap()).unwrap().contains("resume"), "never a credential");
        assert!(store.update("m2", |_| {}).unwrap().is_none());
    }
}
