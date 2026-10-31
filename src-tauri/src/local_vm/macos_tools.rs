//! Pinned Driver/provider file delivery through the already authenticated loader.
//! No process activation, provider login, permission request or package upgrade.
use super::{bootstrap, journal, macos_keys, process};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::Path,
    time::Duration,
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    name: String,
    version: String,
    sha256: String,
    bytes: u64,
    executable: String,
    executable_sha256: String,
    signed_path: String,
    requirement: String,
}
fn specs() -> Vec<Spec> {
    [&bootstrap::DRIVER,&bootstrap::CODEX].into_iter().map(|t|Spec{name:t.name.into(),version:t.version.into(),sha256:t.sha256.into(),bytes:t.bytes,executable:t.executable.into(),executable_sha256:t.executable_sha256.into(),signed_path:t.signed_path.into(),requirement:format!("=anchor apple generic and identifier \"{}\" and certificate leaf[subject.OU] = \"{}\"",t.identifier,t.publisher_team)}).collect()
}
pub(super) fn profiles() -> Value {
    json!(specs())
}
pub(super) fn packet(intent: &super::macos_delivery::Intent) -> Result<Vec<u8>> {
    let mut packet = serde_json::to_vec(&json!({"intent":intent,"profiles":specs()}))?;
    packet.push(b'\n');
    for tool in [&bootstrap::DRIVER, &bootstrap::CODEX] {
        packet.extend(bootstrap::retained_archive(tool)?);
    }
    Ok(packet)
}
pub(super) struct Programs<'a> {
    pub tar: &'a Path,
    pub codesign: &'a Path,
    pub ditto: &'a Path,
}
fn verify(programs: &Programs<'_>, path: &Path, spec: &Spec) -> Result<()> {
    process::run(
        std::process::Command::new(programs.codesign)
            .args(["--verify", "--strict"])
            .arg(path),
        b"",
        Duration::from_secs(30),
    )?;
    process::run(
        std::process::Command::new(programs.codesign)
            .args(["--verify", "-R", &spec.requirement])
            .arg(path),
        b"",
        Duration::from_secs(30),
    )?;
    Ok(())
}
fn executable_matches(path: &Path, expected: &str) -> Result<bool> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    // SAFETY: geteuid has no memory preconditions.
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
        || metadata.mode() & 0o100 == 0
        || metadata.len() > 512 * 1024 * 1024
    {
        bail!("Guest tool must be an owned executable without writable aliases")
    }
    let mut bytes = Vec::new();
    file.take(512 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    Ok(bytes.len() <= 512 * 1024 * 1024 && journal::digest(&bytes) == expected)
}
#[allow(clippy::too_many_arguments)] // Private fixture seam; production paths/specs/programs are fixed.
fn install_using(
    home: &Path,
    applications: &Path,
    directory: &Path,
    intent: &super::macos_delivery::Intent,
    catalog: &[Spec],
    action: &str,
    input: &mut dyn Read,
    programs: &Programs<'_>,
) -> Result<Value> {
    let parent: Value = serde_json::from_slice(&macos_keys::private_read(
        &directory.join("install-receipt.json"),
        128 * 1024,
    )?)?;
    if parent["intent"] != json!(intent) || parent["stage"] != "installed" {
        bail!("Original completed runtime installer required before tool delivery")
    }
    let base = home.join(".terminalx-local");
    macos_keys::check_directory(&base)?;
    if base.join("runtime/run").try_exists()? || base.join("runtime/local-vm-guest").try_exists()? {
        bail!("Serving/previous owner requires its existing lifecycle; bootstrap cannot change it")
    }
    let path = directory.join("tools");
    let existed = path.try_exists()?;
    if !existed {
        if action != "toolsInstall" {
            bail!("Original tool delivery missing")
        }
        journal::private_directory(&path)?;
    }
    macos_keys::check_directory(&path)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(!existed)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path.join("installer.lock"))?;
    // SAFETY: descriptor is owned for the full installer transaction.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("Original tool installer is active")
    }
    let manifest = json!({"intent":intent,"profiles":catalog});
    let receipt_path = path.join("receipt.json");
    let record = if existed {
        let prior: Value =
            serde_json::from_slice(&macos_keys::private_read(&receipt_path, 128 * 1024)?)?;
        if prior["manifest"] != manifest || prior["stage"] != "toolsInstalled" {
            bail!("Original tool delivery is changed/unknown; installation is never replayed")
        }
        prior
    } else {
        macos_keys::write_new(
            &receipt_path,
            &serde_json::to_vec(&json!({"manifest":manifest,"stage":"outcomeUnknown"}))?,
        )?;
        if applications.join("CuaDriver.app").try_exists()?
            || base.join("bin/codex").try_exists()?
        {
            bail!("Existing guest tools cannot be overwritten by bootstrap")
        }
        // Verify every pinned archive before extraction or destination mutation.
        for spec in catalog {
            let mut bytes = vec![0; usize::try_from(spec.bytes)?];
            input.read_exact(&mut bytes)?;
            if journal::digest(&bytes) != spec.sha256 {
                bail!("Pinned guest tool archive changed")
            }
            macos_keys::write_new(&path.join(format!("{}.tar.gz", spec.name)), &bytes)?;
        }
        if input.read(&mut [0; 1])? != 0 {
            bail!("Trailing tool payload refused")
        }
        for spec in catalog {
            let unpack = path.join(format!("{}-unpacked", spec.name));
            journal::private_directory(&unpack)?;
            process::run(
                std::process::Command::new(programs.tar)
                    .arg("-xzf")
                    .arg(path.join(format!("{}.tar.gz", spec.name)))
                    .arg("-C")
                    .arg(&unpack),
                b"",
                Duration::from_secs(120),
            )?;
            let executable = unpack.join(&spec.executable);
            // Only verified, compiled-catalog archives are extracted. Each
            // executable must also be an owned regular file with the pinned hash.
            if !executable_matches(&executable, &spec.executable_sha256)? {
                bail!("Extracted pinned executable differs")
            }
            verify(programs, &unpack.join(&spec.signed_path), spec)?;
        }
        for spec in catalog {
            let unpack = path.join(format!("{}-unpacked", spec.name));
            if spec.name == "cua-driver" {
                // No sudo/permissions bypass. An unwritable Applications
                // directory leaves a retained unknown receipt for inspection.
                use std::os::unix::fs::DirBuilderExt;
                let destination = applications.join("CuaDriver.app");
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&destination)?;
                process::run(
                    std::process::Command::new(programs.ditto)
                        .arg(unpack.join(&spec.signed_path))
                        .arg(&destination),
                    b"",
                    Duration::from_secs(120),
                )?;
                verify(programs, &destination, spec)?;
            } else if spec.name == "codex" {
                let destination = base.join("bin/codex");
                macos_keys::write_new(
                    &destination,
                    &std::fs::read(unpack.join(&spec.executable))?,
                )?;
                std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o700))?;
                verify(programs, &destination, spec)?;
            } else {
                bail!("Unrecognized compiled tool profile")
            }
        }
        let done = json!({"manifest":manifest,"stage":"toolsInstalled"});
        journal::atomic_private_write(&receipt_path, &serde_json::to_vec(&done)?)?;
        done
    };
    for spec in catalog {
        let (app, executable) = if spec.name == "cua-driver" {
            (
                applications.join("CuaDriver.app"),
                applications.join("CuaDriver.app/Contents/MacOS/cua-driver"),
            )
        } else {
            (base.join("bin/codex"), base.join("bin/codex"))
        };
        if !executable_matches(&executable, &spec.executable_sha256)? {
            bail!("Installed guest tool changed")
        }
        verify(programs, &app, spec)?;
    }
    let mut result = record;
    result["inputDigest"] = json!(intent.digest()?);
    result["runtimeSha256"] = json!(intent.plan.runtime_sha256);
    result["identity"] = intent.plan.identity.clone();
    result["profiles"] = json!(catalog);
    result["exitProof"] = json!("terminalReceiptUnderOriginalLock");
    result["ready"] = json!(false);
    Ok(result)
}
pub(super) fn guest(
    home: &Path,
    directory: &Path,
    intent: &super::macos_delivery::Intent,
    action: &str,
    input: &mut dyn Read,
) -> Result<Value> {
    install_using(
        home,
        Path::new("/Applications"),
        directory,
        intent,
        &specs(),
        action,
        input,
        &Programs {
            tar: Path::new("/usr/bin/tar"),
            codesign: Path::new("/usr/bin/codesign"),
            ditto: Path::new("/usr/bin/ditto"),
        },
    )
}
#[cfg(test)]
#[path = "macos_tools_tests.rs"]
mod tests;
