//! Pinned, private tool preparation. No shell installers, host enrollment,
//! privilege escalation, TCC reset or replacement of globally installed tools.
use super::{host, journal, process};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

pub const TEAM: &str = "YCK386LBJ7";
pub fn owner_runtime_sha256() -> Result<String> {
    use sha2::{Digest, Sha256};
    static HASH: std::sync::OnceLock<std::result::Result<String, String>> =
        std::sync::OnceLock::new();
    HASH.get_or_init(|| {
        (|| -> Result<String> {
            let mut file = fs::File::open(std::env::current_exe()?)?;
            let mut hash = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            Ok(format!("{:x}", hash.finalize()))
        })()
        .map_err(|e| format!("{e:#}"))
    })
    .clone()
    .map_err(anyhow::Error::msg)
}
pub struct Tool {
    pub name: &'static str,
    pub version: &'static str,
    pub archive: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    pub signed_path: &'static str,
    pub executable: &'static str,
    pub executable_sha256: &'static str,
    pub publisher_team: &'static str,
    pub identifier: &'static str,
}

pub const CUA: Tool = Tool { name:"cua", version:"0.7.0",
    archive:"https://github.com/trycua/cua/releases/download/cua-sdk-v0.7.0/cua-cli-0.7.0-darwin-arm64.tar.gz",
    sha256:"2d9d7399bc4a595336534acb8fdc0af1ee77cd28830896fec99c5165dbe1befe", bytes:39_729_980,
    signed_path:"cua", executable:"cua",executable_sha256:"bfca362f9bf566107181dd5b2fbbdf428d65ea778822da902bf654486cad7c9e",publisher_team:TEAM,identifier:"cua" };
pub const LUME: Tool = Tool {
    name: "lume",
    version: "0.6.1",
    archive:
        "https://github.com/trycua/cua/releases/download/lume-v0.6.1/lume-0.6.1-darwin-arm64.tar.gz",
    sha256: "2675b7981b7d3eb525cd27f40a385c986052eb71b3360c0b2579644725f1bad8",
    bytes: 6_112_964,
    signed_path: "lume.app",
    executable: "lume.app/Contents/MacOS/lume",
    executable_sha256: "a369d63746690afe79626e357241df2f95b523e7f6f60ac9bc7665762abfc904",
    publisher_team: TEAM,
    identifier: "com.trycua.lume",
};
pub const DRIVER: Tool = Tool { name:"cua-driver", version:"0.28.0",
    archive:"https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.0/cua-driver-rs-0.28.0-darwin-arm64.tar.gz",
    sha256:"82ea1801a5a800b2e46199e8b88694e8bba5670fd533c63a32766c753300d4d6", bytes:69_833_421,
    signed_path:"cua-driver-rs-0.28.0-darwin-arm64/CuaDriver.app", executable:"cua-driver-rs-0.28.0-darwin-arm64/CuaDriver.app/Contents/MacOS/cua-driver",
    executable_sha256:"77d5c35ff2e313613423e4d52c91ea1af0bffbc5b0ca2c641ac473e445f081cb",publisher_team:TEAM,identifier:"com.trycua.driver" };
pub const CODEX:Tool=Tool{name:"codex",version:"0.156.1",
    archive:"https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-aarch64-apple-darwin.tar.gz",
    sha256:"2bd64af14dedd47795f2f6bfd5d125cf79199acc2c7ba222144e08127111a5ca",bytes:94_626_816,
    signed_path:"codex-aarch64-apple-darwin",executable:"codex-aarch64-apple-darwin",
    executable_sha256:"0196e89fe5a7598f816ee54232c3d7c26d75e502ab5cfe2c9240e81d90f7255a",publisher_team:"2DC432GLL2",identifier:"codex"};

fn base(tool: &Tool) -> Result<PathBuf> {
    Ok(host::root()?.join("tools").join(tool.sha256))
}

pub fn profile() -> Value {
    json!({"id":super::creation::PROFILE,"creation":super::creation::capability(),"image":host::IMAGE,"imageBytes":host::DOWNLOAD_BYTES,
        "cpu":4,"memoryBytes":8_589_934_592_u64,"diskLimitBytes":161_061_273_600_u64,
        "tools":[{"name":CUA.name,"version":CUA.version,"downloadBytes":CUA.bytes},
            {"name":LUME.name,"version":LUME.version,"downloadBytes":LUME.bytes},
            {"name":DRIVER.name,"version":DRIVER.version,"downloadBytes":DRIVER.bytes},
            {"name":CODEX.name,"version":CODEX.version,"downloadBytes":CODEX.bytes}],
        "runtime":"The signed runtime bundled with this TerminalX owner; copied and checksum verified automatically",
        "templatePermissionInheritanceVerified":false,"hostEnrollment":false,"hostCredentialCopy":false})
}

fn ensure_running() -> Result<()> {
    if super::supervisor::stopping() {
        bail!("Owner stopped during tool preparation; no VM operation was started");
    }
    Ok(())
}

fn verify_signature(tool: &Tool, path: &Path) -> Result<()> {
    process::run(
        std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(path),
        b"",
        Duration::from_secs(15),
    )
    .with_context(|| {
        format!(
            "Pinned {} {} package signature verification failed",
            tool.name, tool.version
        )
    })?;
    // Pin the publisher in addition to the exact archive digest. Developer ID
    // identity is retained when tools are placed outside global install paths.
    verify_requirement(
        path,
        &format!(
            "anchor apple generic and identifier \"{}\" and certificate leaf[subject.OU] = \"{}\"",
            tool.identifier, tool.publisher_team
        ),
    )
    .with_context(|| {
        format!(
            "Pinned {} {} publisher verification failed",
            tool.name, tool.version
        )
    })?;
    Ok(())
}

fn verify_requirement(path: &Path, expression: &str) -> Result<()> {
    process::run(
        std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "-R"])
            // Without '=' codesign treats this argument as a requirement file.
            .arg(format!("={expression}"))
            .arg(path),
        b"",
        Duration::from_secs(15),
    )?;
    Ok(())
}

pub fn installed(name: &str) -> Result<Option<PathBuf>> {
    let tool = match name {
        "cua" => &CUA,
        "lume" => &LUME,
        _ => return Ok(None),
    };
    let dir = base(tool)?;
    if !dir.try_exists()? {
        return Ok(None);
    }
    validate_install(tool, &dir)?;
    Ok(Some(dir.join(tool.executable)))
}

fn validate_install(tool: &Tool, dir: &Path) -> Result<()> {
    let receipt: Value = serde_json::from_slice(&fs::read(dir.join("terminalx-tool.json"))?)?;
    if receipt["archiveSha256"] != tool.sha256
        || receipt["name"] != tool.name
        || receipt["version"] != tool.version
    {
        bail!(
            "Retained tool preparation differs from the pinned profile; refusing to overwrite it"
        );
    }
    if journal::digest(&fs::read(dir.join(tool.executable))?) != tool.executable_sha256 {
        bail!("Prepared tool executable differs from the pinned release; refusing to use it");
    }
    verify_signature(tool, &dir.join(tool.signed_path))
}

/// Materialize only immutable verified bytes. Interrupted preparation can read
/// its cache again; it never runs an installer or creates/replays a VM.
pub fn prepare(tool: &Tool) -> Result<PathBuf> {
    ensure_running()?;
    let target = base(tool)?;
    if target.try_exists()? {
        validate_install(tool, &target)?;
        return Ok(target);
    }
    let parent = target.parent().context("Tool cache unavailable")?;
    journal::private_directory(parent)?;
    let stage = tempfile::tempdir_in(parent)?;
    let archive = stage.path().join("download.tar.gz");
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(90))
        .build()
        .get(tool.archive)
        .call()
        .context("Download the disclosed pinned tool; check networking and retry setup")?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(tool.bytes + 1)
        .read_to_end(&mut bytes)?;
    verify_download(tool, &bytes)?;
    ensure_running()?;
    fs::write(&archive, &bytes)?;
    let unpack = stage.path().join("unpacked");
    journal::private_directory(&unpack)?;
    // Extraction happens only after matching the reviewed release's exact
    // checksum/size. No upstream install script is executed.
    process::run(
        std::process::Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&unpack),
        b"",
        Duration::from_secs(60),
    )?;
    verify_signature(tool, &unpack.join(tool.signed_path))?;
    if journal::digest(&fs::read(unpack.join(tool.executable))?) != tool.executable_sha256 {
        bail!("Pinned executable checksum differs from the reviewed release");
    }
    fs::copy(&archive, unpack.join("terminalx-archive.tar.gz"))?;
    journal::atomic_private_write(
        &unpack.join("terminalx-tool.json"),
        &serde_json::to_vec(&json!({
        "name":tool.name,"version":tool.version,"archiveSha256":tool.sha256,"publisherTeam":tool.publisher_team}))?,
    )?;
    ensure_running()?;
    match fs::rename(&unpack, &target) {
        Ok(()) => {}
        Err(error) if target.try_exists()? => {
            validate_install(tool, &target).with_context(|| error.to_string())?;
        }
        Err(error) => return Err(error.into()),
    }
    fs::File::open(parent)?.sync_all()?;
    Ok(target)
}

fn verify_download(tool: &Tool, bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 != tool.bytes || journal::digest(bytes) != tool.sha256 {
        bail!(
            "Pinned {} download checksum/size did not match; nothing was installed",
            tool.name
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn inline_signature_requirement_accepts_the_exact_signed_app_and_rejects_another_identity() {
        let app = Path::new("/System/Applications/TextEdit.app");
        assert!(
            verify_requirement(app, "anchor apple and identifier \"com.apple.TextEdit\"").is_ok()
        );
        assert!(
            verify_requirement(app, "anchor apple and identifier \"com.apple.Calculator\"")
                .is_err()
        );
    }
    #[test]
    fn modified_or_incomplete_bootstrap_bytes_are_never_installable() {
        for tool in [&CUA, &LUME, &DRIVER, &CODEX] {
            assert!(verify_download(tool, b"untrusted installer or partial download").is_err());
            assert!(
                tool.archive
                    .starts_with("https://github.com/trycua/cua/releases/download/")
                    || tool
                        .archive
                        .starts_with("https://github.com/openai/codex/releases/download/")
            );
            assert_eq!(tool.sha256.len(), 64);
        }
        let exact = Tool {
            name: "test",
            version: "1",
            archive: "",
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            bytes: 3,
            signed_path: "",
            executable: "",
            executable_sha256: "",
            publisher_team: "",
            identifier: "",
        };
        assert!(verify_download(&exact, b"abc").is_ok());
        assert!(verify_download(&exact, b"abcd").is_err());
    }
}
