//! Verification and staging for the private workspace OpenSSH payload.
use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const NAMESPACE: &str = "terminalx-workspace-openssh";
const MAX_MANIFEST: usize = 4096;
const MAX_SIGNATURE: usize = 4096;
pub(super) const MAX_PAYLOAD: usize = 128 * 1024 * 1024;
const MAX_UNPACKED: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Architecture {
    X86_64,
    Aarch64,
}

impl Architecture {
    fn label(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Version([u32; 4]);

impl Version {
    pub(super) fn parse(text: &str) -> Result<Self> {
        let number = |field: &str| -> Result<u32> {
            let n = field.parse::<u32>()?;
            ensure!(n.to_string() == field, "noncanonical OpenSSH version");
            Ok(n)
        };
        let (portable, build) = match text.split_once("-terminalx.") {
            Some((portable, build)) => {
                let build = number(build)?;
                ensure!(build != 0, "invalid TerminalX build revision");
                (portable, build)
            }
            None => (text, 0),
        };
        let (release, patch) = portable.split_once('p').context("missing portable patch")?;
        let (major, minor) = release
            .split_once('.')
            .context("missing OpenSSH minor version")?;
        let version = Self([number(major)?, number(minor)?, number(patch)?, build]);
        ensure!(
            version.0[..3] >= [9, 6, 1][..],
            "OpenSSH is below the minimum version"
        );
        Ok(version)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    v: u8,
    version: String,
    artifacts: Vec<Artifact>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    arch: Architecture,
    locator: String,
    sha256: String,
}

pub(super) struct VerifiedManifest {
    version: String,
    locator: String,
    digest: String,
}

impl VerifiedManifest {
    pub(super) fn version(&self) -> &str {
        &self.version
    }
    pub(super) fn locator(&self) -> &str {
        &self.locator
    }
}

pub(super) fn verify_manifest(
    bytes: &[u8],
    signature: &[u8],
    architecture: Architecture,
    active: Option<&Version>,
) -> Result<VerifiedManifest> {
    verify_with_key(
        bytes,
        signature,
        architecture,
        active,
        crate::serve_cli::RUNTIME_SIGNING_KEY,
    )
}

fn verify_with_key(
    bytes: &[u8],
    signature: &[u8],
    architecture: Architecture,
    active: Option<&Version>,
    key: &str,
) -> Result<VerifiedManifest> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_MANIFEST,
        "invalid manifest length"
    );
    ensure!(
        !signature.is_empty() && signature.len() <= MAX_SIGNATURE,
        "invalid signature length"
    );
    let scratch = tempfile::tempdir()?;
    let signers = scratch.path().join("allowed_signers");
    let signed = scratch.path().join("manifest.sig");
    fs::write(
        &signers,
        format!("{} {key}\n", crate::serve_cli::SIGNER_PRINCIPAL),
    )?;
    fs::write(&signed, signature)?;
    let mut child = Command::new("/usr/bin/ssh-keygen")
        .args(["-Y", "verify", "-f"])
        .arg(signers)
        .args([
            "-I",
            crate::serve_cli::SIGNER_PRINCIPAL,
            "-n",
            NAMESPACE,
            "-s",
        ])
        .arg(signed)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let wrote = child
        .stdin
        .take()
        .context("missing signature verifier input")?
        .write_all(bytes);
    let status = child.wait()?;
    wrote?;
    ensure!(
        status.success(),
        "OpenSSH manifest signature did not verify"
    );

    let manifest: Manifest = serde_json::from_slice(bytes)?;
    ensure!(manifest.v == 1, "unsupported OpenSSH manifest schema");
    let version = Version::parse(&manifest.version)?;
    ensure!(
        active.is_none_or(|active| &version >= active),
        "OpenSSH downgrade refused"
    );
    let mut selected = None;
    let mut seen = Vec::new();
    for artifact in manifest.artifacts {
        ensure!(
            !seen.contains(&artifact.arch),
            "duplicate OpenSSH architecture"
        );
        seen.push(artifact.arch);
        let locator = format!(
            "openssh-{}-linux-{}.tar.gz",
            manifest.version,
            artifact.arch.label()
        );
        ensure!(
            artifact.locator == locator,
            "invalid OpenSSH artifact locator"
        );
        ensure!(
            artifact.sha256.len() == 64
                && artifact
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid OpenSSH artifact digest"
        );
        if artifact.arch == architecture {
            selected = Some(VerifiedManifest {
                version: manifest.version.clone(),
                locator: artifact.locator,
                digest: artifact.sha256,
            });
        }
    }
    selected.context("no OpenSSH payload for this architecture")
}

/// A guard for the private install directory. Keep it alive across staging
/// and the later listener transaction.
pub(super) struct InstallLock {
    root: PathBuf,
    _guard: File,
}

impl InstallLock {
    pub(super) fn acquire(root: &Path) -> Result<Self> {
        let meta = fs::symlink_metadata(root)?;
        ensure!(
            meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0,
            "OpenSSH install root must be an owner-controlled directory"
        );
        let guard = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join(".install.lock"))?;
        ensure!(guard.metadata()?.is_file(), "invalid OpenSSH install lock");
        guard.lock()?;
        Ok(Self {
            root: root.to_path_buf(),
            _guard: guard,
        })
    }

    pub(super) fn stage(&self, manifest: &VerifiedManifest, payload: &[u8]) -> Result<PathBuf> {
        // Verify the actual bytes before either decompressing or writing them.
        ensure!(
            !payload.is_empty() && payload.len() <= MAX_PAYLOAD,
            "invalid payload size"
        );
        ensure!(
            format!("{:x}", Sha256::digest(payload)) == manifest.digest,
            "OpenSSH payload digest mismatch"
        );

        // Recheck under the install lock. A different updater may have
        // activated a newer version since this manifest was verified.
        match fs::read_link(self.root.join("current")) {
            Ok(active) => {
                let active = active.to_str().context("invalid OpenSSH current link")?;
                ensure!(
                    Version::parse(&manifest.version)? >= Version::parse(active)?,
                    "OpenSSH downgrade refused under install lock"
                );
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let target = self.root.join(&manifest.version);
        match fs::symlink_metadata(&target) {
            Ok(_) => bail!("OpenSSH version directory already exists"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let scratch = tempfile::Builder::new()
            .prefix(".staging-")
            .tempdir_in(&self.root)?;
        unpack(payload, scratch.path())?;
        // Rename only after every entry passed validation. Keep the temporary
        // guard until the rename succeeds so partial errors are cleaned up.
        fs::rename(scratch.path(), &target)?;
        File::open(&self.root)?.sync_all()?;
        Ok(target)
    }
}

fn unpack(payload: &[u8], directory: &Path) -> Result<()> {
    let reader = flate2::bufread::GzDecoder::new(payload);
    let mut archive = tar::Archive::new(io::Read::take(reader, MAX_UNPACKED + 1));
    let mut paths = std::collections::HashSet::new();
    let mut directories = std::collections::BTreeSet::new();
    let mut size = 0u64;
    let mut sshd = false;
    for entry in archive.entries()?.raw(true) {
        let mut entry = entry?;
        ensure!(
            paths.len() < MAX_ENTRIES,
            "too many OpenSSH archive entries"
        );
        let kind = entry.header().entry_type();
        ensure!(
            kind.is_file() || kind.is_dir(),
            "unsupported OpenSSH archive entry"
        );
        let bytes = entry.path_bytes();
        let text = std::str::from_utf8(&bytes)?;
        let text = if kind.is_dir() {
            text.strip_suffix('/').unwrap_or(text)
        } else {
            text
        };
        ensure!(
            text.len() <= 240
                && text.split('/').all(|part| !part.is_empty()
                    && part != "."
                    && part != ".."
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))),
            "unsafe OpenSSH archive path"
        );
        ensure!(
            paths.insert(text.to_owned()),
            "duplicate OpenSSH archive entry"
        );
        let header = entry.header();
        ensure!(
            header.uid()? == 0 && header.gid()? == 0,
            "unexpected OpenSSH archive ownership"
        );
        let mode = header.mode()?;
        ensure!(
            mode & !0o777 == 0 && mode & 0o022 == 0,
            "unsafe OpenSSH archive permissions"
        );
        let length = entry.size();
        size = size
            .checked_add(length)
            .context("OpenSSH archive size overflow")?;
        ensure!(
            size <= MAX_UNPACKED,
            "OpenSSH archive expands beyond its limit"
        );
        let is_sshd = text == "usr/sbin/sshd";
        let output = directory.join(text);
        if kind.is_dir() {
            ensure!(length == 0, "invalid OpenSSH archive directory");
            fs::create_dir_all(&output)?;
            directories.insert(output);
            continue;
        }
        let parent = output.parent().context("missing payload parent")?;
        fs::create_dir_all(parent)?;
        directories.extend(
            parent
                .ancestors()
                .take_while(|path| *path != directory)
                .map(Path::to_path_buf),
        );
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&output)?;
        ensure!(
            io::copy(&mut entry, &mut file)? == length,
            "truncated OpenSSH payload"
        );
        let executable = mode & 0o111 != 0;
        file.set_permissions(fs::Permissions::from_mode(if executable {
            0o555
        } else {
            0o444
        }))?;
        file.sync_all()?;
        sshd |= is_sshd && executable;
    }
    // Finish the gzip member, including its checksum and length trailer.
    // After the TAR terminator only zero padding is allowed.
    let mut remaining = archive.into_inner();
    let mut padding = [0; 4096];
    loop {
        let read = remaining.read(&mut padding)?;
        if read == 0 {
            break;
        }
        ensure!(
            padding[..read].iter().all(|byte| *byte == 0),
            "nonzero OpenSSH archive padding"
        );
    }
    ensure!(
        remaining.limit() > 0,
        "OpenSSH archive expands beyond its limit"
    );
    ensure!(
        remaining.into_inner().into_inner().is_empty(),
        "trailing OpenSSH compressed data"
    );
    ensure!(sshd, "OpenSSH payload has no executable usr/sbin/sshd");
    for path in directories.iter().rev() {
        File::open(path)?.sync_all()?;
    }
    // The install tree is owner-controlled; remove write access from the
    // published version. Maintenance can explicitly retire it under the lock.
    for path in directories.iter().rev() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o555))?;
    }
    fs::set_permissions(directory, fs::Permissions::from_mode(0o555))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
#[path = "workspace_ssh_payload_tests.rs"]
mod tests;
