//! Validation seeding tool for the person-run steps of validation plan Run 1
//! (phases 1.2, 1.3 and 1.5). It is not the bundled seed daemon and is never
//! part of onboarding. It never attaches, mounts or detaches a disk: the
//! reviewed run sheet does that. It seeds only the validation profile, with
//! the plist compiled in and a fresh random validation key, as root:wheel.
//!
//!   terminalx-vm-seed volumes  <whole-disk, e.g. disk5>
//!   terminalx-vm-seed release  <system-volume-mount>
//!   terminalx-vm-seed inspect  <data-volume-mount>
//!   terminalx-vm-seed seed     <data-volume-mount> <probe-executable>
//!   terminalx-vm-seed readback <data-volume-mount> <seed-receipt.json>
//!
//! JSON goes to stdout. Exit 0 on success, 2 on a refusal, 64 on bad usage.
#[cfg(target_os = "macos")]
mod tool {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::{json, Value};
    use std::path::Path;
    use terminalx_vm_bootstrap::{disk, random, seed};

    const PLIST: &[u8] = include_bytes!("../../com.terminalx.next.vm-validation-probe.plist");
    const PROBE_LIMIT: u64 = 64 << 20;

    pub enum Failure {
        Usage,
        Refused(String),
    }

    fn refused(reason: impl std::fmt::Display) -> Failure {
        Failure::Refused(reason.to_string())
    }

    /// A thin arm64 Mach-O executable: the only probe format this run seeds.
    fn probe(path: &Path) -> Result<Vec<u8>, Failure> {
        let metadata = std::fs::symlink_metadata(path).map_err(refused)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > PROBE_LIMIT {
            return Err(refused("probe must be a regular file of at most 64 MiB"));
        }
        let bytes = std::fs::read(path).map_err(refused)?;
        if bytes.len() < 8
            || bytes[..4] != [0xcf, 0xfa, 0xed, 0xfe]
            || bytes[4..8] != [0x0c, 0x00, 0x00, 0x01]
        {
            return Err(refused("probe must be a thin arm64 Mach-O executable"));
        }
        Ok(bytes)
    }

    fn key() -> Result<(String, Vec<u8>), Failure> {
        let seed_id = terminalx_vm_bootstrap::hex(&random::<16>().map_err(refused)?);
        let key = STANDARD.encode(random::<32>().map_err(refused)?);
        let bytes = serde_json::to_vec(
            &json!({"key": key, "purpose": "validation", "seedId": seed_id, "version": 1}),
        )
        .map_err(refused)?;
        Ok((seed_id, bytes))
    }

    pub fn run(args: &[String]) -> Result<Value, Failure> {
        match args {
            [command, whole] if command == "volumes" => disk::list(whole).map_err(refused),
            [command, volume] if command == "release" => {
                let (dir, mount) = seed::open_volume(Path::new(volume), false).map_err(refused)?;
                let mut release = disk::release(&dir).map_err(refused)?;
                release["mount"] = mount.to_json();
                Ok(release)
            }
            [command, volume] if command == "inspect" => {
                let (dir, mount) = seed::open_volume(Path::new(volume), false).map_err(refused)?;
                let pristine = seed::pristine(&dir).map_err(refused)?;
                Ok(
                    json!({"mount": mount.to_json(), "device": dir.stat.st_dev, "pristine": pristine}),
                )
            }
            [command, volume, executable] if command == "seed" => {
                // SAFETY: geteuid has no preconditions.
                if unsafe { libc::geteuid() } != 0 {
                    return Err(refused(
                        "seeding writes root:wheel items and must run as root",
                    ));
                }
                let probe = probe(Path::new(executable))?;
                let (dir, mount) = seed::open_volume(Path::new(volume), true).map_err(refused)?;
                let (seed_id, key) = key()?;
                let mut receipt = seed::seed(
                    &dir,
                    &seed::VALIDATION,
                    [PLIST, &probe, &key],
                    seed::Owner::ROOT,
                )
                .map_err(refused)?;
                receipt["seedId"] = json!(seed_id);
                receipt["mount"] = mount.to_json();
                Ok(receipt)
            }
            [command, volume, receipt] if command == "readback" => {
                let receipt: Value =
                    serde_json::from_slice(&std::fs::read(receipt).map_err(refused)?)
                        .map_err(refused)?;
                let (dir, mount) = seed::open_volume(Path::new(volume), false).map_err(refused)?;
                if receipt["device"].is_null() {
                    return Err(refused("receipt has no device"));
                }
                let mut report =
                    seed::readback(&dir, &seed::VALIDATION, &receipt).map_err(refused)?;
                report["mount"] = mount.to_json();
                Ok(report)
            }
            _ => Err(Failure::Usage),
        }
    }
}

#[cfg(target_os = "macos")]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match tool::run(&args) {
        Ok(report) => println!("{report}"),
        Err(tool::Failure::Usage) => {
            eprintln!("usage: terminalx-vm-seed volumes <diskN> | release <volume> | inspect <volume> | seed <volume> <probe> | readback <volume> <receipt>");
            std::process::exit(64);
        }
        Err(tool::Failure::Refused(reason)) => {
            eprintln!("terminalx-vm-seed: refused: {reason}");
            std::process::exit(2);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("terminalx-vm-seed runs only on a macOS host");
    std::process::exit(2);
}
