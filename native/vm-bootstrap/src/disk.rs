//! Seeder contract step 2 checks on an attached guest disk image (validation
//! plan G1): exactly one APFS `System` and one `Data` volume on the image, in
//! the same container, the Data volume unencrypted and unlocked; and the
//! System volume's macOS release. Nothing here attaches, mounts or writes.
use crate::{fsx::Dir, seed::Refusal};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
};

/// Converts plist bytes (XML or binary) to JSON with the system's plutil.
pub fn plist_json(bytes: &[u8]) -> Result<Value, Refusal> {
    let mut child = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Refusal(format!("plutil: {e}")))?;
    child
        .stdin
        .take()
        .ok_or_else(|| Refusal("plutil stdin".into()))?
        .write_all(bytes)
        .map_err(|e| Refusal(format!("plutil: {e}")))?;
    let output = child
        .wait_with_output()
        .map_err(|e| Refusal(format!("plutil: {e}")))?;
    if !output.status.success() {
        return Err(Refusal(format!(
            "plutil: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| Refusal(format!("plutil JSON: {e}")))
}

/// A whole-disk identifier such as `disk5`, never a slice or a path.
fn whole_disk(name: &str) -> Result<&str, Refusal> {
    let digits = name.strip_prefix("disk").unwrap_or("");
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Refusal(format!(
            "{name:?} is not a whole-disk identifier like disk5"
        )));
    }
    Ok(name)
}

/// Interprets `diskutil apfs list -plist` (as JSON) for the image on `whole`.
pub fn roles(listing: &Value, whole: &str) -> Result<Value, Refusal> {
    let whole = whole_disk(whole)?;
    let slice = format!("{whole}s");
    let on_image = |container: &&Value| {
        container["PhysicalStores"]
            .as_array()
            .is_some_and(|stores| {
                stores.iter().any(|store| {
                    store["DeviceIdentifier"].as_str().is_some_and(|id| {
                        id.strip_prefix(&slice)
                            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                    })
                })
            })
    };
    let containers: Vec<&Value> = listing["Containers"]
        .as_array()
        .ok_or_else(|| Refusal("diskutil listing has no Containers".into()))?
        .iter()
        .filter(on_image)
        .collect();
    let mut found: Vec<(&str, &Value, &Value)> = Vec::new();
    let mut other = Vec::new();
    for container in &containers {
        for volume in container["Volumes"].as_array().into_iter().flatten() {
            let roles: Vec<&str> = volume["Roles"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            match roles.as_slice() {
                ["System"] => found.push(("System", container, volume)),
                ["Data"] => found.push(("Data", container, volume)),
                _ => other.push(json!({"device": volume["DeviceIdentifier"], "roles": roles})),
            }
        }
    }
    let one = |role: &str| -> Result<(&Value, &Value), Refusal> {
        let matches: Vec<_> = found.iter().filter(|(r, _, _)| *r == role).collect();
        match matches.as_slice() {
            [(_, container, volume)] => Ok((container, volume)),
            _ => Err(Refusal(format!(
                "image {whole} has {} {role} volumes, not exactly one",
                matches.len()
            ))),
        }
    };
    let (system_container, system) = one("System")?;
    let (data_container, data) = one("Data")?;
    if system_container["ContainerReference"] != data_container["ContainerReference"] {
        return Err(Refusal(
            "System and Data volumes are in different containers".into(),
        ));
    }
    let flags = (&data["Encryption"], &data["FileVault"], &data["Locked"]);
    if flags != (&json!(false), &json!(false), &json!(false)) {
        return Err(Refusal(format!(
            "Data volume is not plainly readable: encryption {}, FileVault {}, locked {}",
            flags.0, flags.1, flags.2
        )));
    }
    Ok(
        json!({"wholeDisk": whole, "container": data_container["ContainerReference"],
        "system": {"device": system["DeviceIdentifier"], "name": system["Name"]},
        "data": {"device": data["DeviceIdentifier"], "name": data["Name"], "encryption": false, "fileVault": false, "locked": false},
        "otherVolumes": other}),
    )
}

/// Runs `diskutil apfs list -plist` and interprets it for `whole`.
pub fn list(whole: &str) -> Result<Value, Refusal> {
    let whole = whole_disk(whole)?;
    let output = Command::new("/usr/sbin/diskutil")
        .args(["apfs", "list", "-plist"])
        .output()
        .map_err(|e| Refusal(format!("diskutil: {e}")))?;
    if !output.status.success() {
        return Err(Refusal(format!(
            "diskutil: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    roles(&plist_json(&output.stdout)?, whole)
}

/// Reads SystemVersion.plist from a mounted System volume, without following links.
pub fn release(system: &Dir) -> Result<Value, Refusal> {
    let dir = system
        .walk(&["System", "Library", "CoreServices"], |_, _| Ok(()))
        .map_err(|e| Refusal(format!("CoreServices: {e}")))?;
    let (file, _) = dir
        .open_regular("SystemVersion.plist")
        .map_err(|e| Refusal(format!("SystemVersion.plist: {e}")))?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Refusal(format!("SystemVersion.plist: {e}")))?;
    if bytes.len() > 64 * 1024 {
        return Err(Refusal("SystemVersion.plist is larger than 64 KiB".into()));
    }
    let plist = plist_json(&bytes)?;
    let version = plist["ProductVersion"]
        .as_str()
        .ok_or_else(|| Refusal("no ProductVersion".into()))?;
    let build = plist["ProductBuildVersion"]
        .as_str()
        .ok_or_else(|| Refusal("no ProductBuildVersion".into()))?;
    let major: Option<u32> = version.split('.').next().and_then(|m| m.parse().ok());
    Ok(
        json!({"productVersion": version, "productBuildVersion": build, "major": major, "macos26": major == Some(26)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volume(device: &str, role: &str, encrypted: bool) -> Value {
        json!({"DeviceIdentifier": device, "Name": role, "Roles": [role], "Encryption": encrypted, "FileVault": encrypted, "Locked": false})
    }

    /// Shaped like a restored Apple silicon VM image: an ISC container, the
    /// main container and a recovery container, plus this host's own disk.
    fn listing(data_encrypted: bool) -> Value {
        json!({"Containers": [
            {"ContainerReference": "disk6", "PhysicalStores": [{"DeviceIdentifier": "disk5s1"}], "Volumes": [volume("disk6s1", "xART", false), volume("disk6s2", "Preboot", false)]},
            {"ContainerReference": "disk7", "PhysicalStores": [{"DeviceIdentifier": "disk5s2"}], "Volumes": [
                volume("disk7s1", "System", false), volume("disk7s2", "Preboot", false), volume("disk7s5", "Data", data_encrypted)]},
            {"ContainerReference": "disk8", "PhysicalStores": [{"DeviceIdentifier": "disk5s3"}], "Volumes": [volume("disk8s1", "Recovery", false)]},
            {"ContainerReference": "disk3", "PhysicalStores": [{"DeviceIdentifier": "disk0s2"}], "Volumes": [volume("disk3s1", "System", true), volume("disk3s5", "Data", true)]},
        ]})
    }

    #[test]
    fn finds_the_images_system_and_data_volumes_only() {
        let found = roles(&listing(false), "disk5").unwrap();
        assert_eq!(
            (
                found["system"]["device"].as_str(),
                found["data"]["device"].as_str()
            ),
            (Some("disk7s1"), Some("disk7s5"))
        );
        assert_eq!(found["container"], "disk7");
        assert_eq!(
            found["otherVolumes"].as_array().unwrap().len(),
            4,
            "host disk0 volumes are ignored"
        );
    }

    #[test]
    fn refuses_encrypted_missing_duplicate_or_unrelated_layouts() {
        assert!(roles(&listing(true), "disk5")
            .unwrap_err()
            .0
            .contains("not plainly readable"));
        assert!(roles(&listing(false), "disk9")
            .unwrap_err()
            .0
            .contains("0 System"));
        assert!(
            roles(&listing(false), "disk5s1").is_err(),
            "slices are not whole disks"
        );
        assert!(roles(&listing(false), "../disk5").is_err());
        let mut twice = listing(false);
        twice["Containers"][1]["Volumes"]
            .as_array_mut()
            .unwrap()
            .push(volume("disk7s9", "Data", false));
        assert!(roles(&twice, "disk5").unwrap_err().0.contains("2 Data"));
        let mut split = listing(false);
        let data = split["Containers"][1]["Volumes"]
            .as_array_mut()
            .unwrap()
            .remove(2);
        split["Containers"][2]["Volumes"]
            .as_array_mut()
            .unwrap()
            .push(data);
        assert!(roles(&split, "disk5")
            .unwrap_err()
            .0
            .contains("different containers"));
        // A disk numbered disk55 is not a slice of disk5.
        let mut lookalike = listing(false);
        lookalike["Containers"][1]["PhysicalStores"][0]["DeviceIdentifier"] = json!("disk55s2");
        assert!(roles(&lookalike, "disk5").is_err());
    }

    #[test]
    fn reads_the_release_from_system_version_without_following_links() {
        let temp = tempfile::tempdir().unwrap();
        let core = temp.path().join("System/Library/CoreServices");
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(core.join("SystemVersion.plist"), br#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>ProductBuildVersion</key><string>25A354</string><key>ProductVersion</key><string>26.0</string></dict></plist>
"#).unwrap();
        let root = Dir::open_root(temp.path()).unwrap();
        let found = release(&root).unwrap();
        assert_eq!(
            found,
            json!({"productVersion": "26.0", "productBuildVersion": "25A354", "major": 26, "macos26": true})
        );

        let linked = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(linked.path().join("System/Library")).unwrap();
        std::os::unix::fs::symlink(&core, linked.path().join("System/Library/CoreServices"))
            .unwrap();
        assert!(release(&Dir::open_root(linked.path()).unwrap()).is_err());
    }

    #[test]
    fn this_hosts_real_listing_parses() {
        // Read-only: the host's own disk0 is not an image, so it must refuse
        // for an unattached disk number rather than invent volumes.
        let error = list("disk99").unwrap_err();
        assert!(error.0.contains("0 System"), "{error}");
    }
}
