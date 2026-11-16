//! `terminalx-serve update`: install the newest signed runtime release next
//! to the running one and restart the service on it (PRO-353).
//!
//! It checks exactly what `scripts/install/install.sh` checks, with the key
//! compiled in here ([`super::RUNTIME_SIGNING_KEY`]): `SHA256SUMS` must carry
//! a good SSH signature (`ssh-keygen -Y verify`), and the binary and
//! `terminalx-serve.json` must match it. A release without a signature, or
//! with a bad one, is refused, and nothing under `~/.terminalx` changes until
//! every check has passed. The new version goes in `versions/<version>` and
//! `current` is swapped to it in one rename; the old version stays, so
//! pointing `current` back is a rollback.
//!
//! The installer's test settings work here too, each with a warning:
//! `TERMINALX_INSTALL_API_URL`, `TERMINALX_INSTALL_BASE_URL` and
//! `TERMINALX_INSTALL_ALLOWED_SIGNERS` (a file in `allowed_signers` form).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{RUNTIME_SIGNING_KEY, SIGNATURE_NAMESPACE, SIGNER_PRINCIPAL};

const USAGE: &str = "\
Usage: terminalx-serve update [--check] [--data-dir <dir>]

Install the newest signed TerminalX runtime and restart the service on it.
Its signature is checked against the TerminalX release key first; a release
that is not signed, or does not verify, is refused. The version it replaces
stays in ~/.terminalx/versions.

  --check   Only say whether a newer signed runtime is available";

const DEFAULT_API_URL: &str = "https://api.github.com/repos/terminalx-ai/terminalx/releases?per_page=100";
const DEFAULT_BASE_URL: &str = "https://github.com/terminalx-ai/terminalx/releases/download";
const SUMS: &str = "SHA256SUMS";
const SIGNATURE: &str = "SHA256SUMS.sig";
const MANIFEST: &str = "terminalx-serve.json";
/// Largest download accepted: the runtime binary is well under this.
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;

/// Run `terminalx-serve update` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    match update(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("terminalx-serve update: {error:#}");
            1
        }
    }
}

fn update(args: &[String]) -> Result<i32> {
    let (flag, rest) = super::take_data_dir(args)?;
    let check_only = match rest.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => false,
        ["--check"] => true,
        ["-h" | "--help" | "help"] => {
            println!("{USAGE}");
            return Ok(0);
        }
        _ => {
            eprintln!("{USAGE}");
            return Ok(2);
        }
    };
    let data = super::resolve_data_dir(flag.as_deref())?;
    let root = super::install_root()?;
    let installed = installed_version(&root)?;
    let source = Source::from_env();
    let asset = asset_name()?;
    let agent = crate::data_privacy::http_agent().timeout(std::time::Duration::from_secs(300)).build();
    let fetch = |url: &str| download(&agent, url);

    let releases = fetch(&source.api_url).with_context(|| format!("list releases from {}", source.api_url))?;
    let Some(newest) = newest_signed(&releases, asset)? else {
        bail!("no signed TerminalX runtime release with {asset} was found; try again later");
    };
    if newest.version <= installed {
        println!("terminalx-serve {installed} is installed, and it is the newest signed runtime.");
        return Ok(0);
    }
    if check_only {
        println!("terminalx-serve {} is available ({}); {installed} is installed. Run `terminalx-serve update` to install it.", newest.version, newest.tag);
        return Ok(0);
    }
    println!("Updating terminalx-serve {installed} to {} ({})...", newest.version, newest.tag);
    let dest = apply(&root, &source, &newest, asset, &fetch)?;
    println!("Installed {} ({} points at it).", dest.display(), root.join("current").display());
    match super::service::restart_for(&data) {
        Ok(true) => println!("Restarted the service on terminalx-serve {}.", newest.version),
        Ok(false) => println!("No service runs this runtime; the next start uses terminalx-serve {}.", newest.version),
        Err(error) => {
            eprintln!("warning: the service was not restarted ({error:#}); it runs {installed} until it restarts.");
            return Ok(1);
        }
    }
    Ok(0)
}

/// Where releases come from and whose signature they need.
struct Source {
    api_url: String,
    base_url: String,
    /// `allowed_signers` text.
    signers: String,
}

impl Source {
    fn from_env() -> Self {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let api_url = env("TERMINALX_INSTALL_API_URL");
        let base_url = env("TERMINALX_INSTALL_BASE_URL");
        if api_url.is_some() || base_url.is_some() {
            eprintln!("warning: downloading from a test location; signatures are still checked");
        }
        let signers = match env("TERMINALX_INSTALL_ALLOWED_SIGNERS") {
            Some(path) => {
                eprintln!("warning: trusting the test signing key in {path} instead of the TerminalX release key");
                std::fs::read_to_string(&path).unwrap_or_default()
            }
            None => Self::release_signers(),
        };
        Self {
            api_url: api_url.unwrap_or_else(|| DEFAULT_API_URL.into()),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.into()).trim_end_matches('/').into(),
            signers,
        }
    }

    fn release_signers() -> String {
        format!("{SIGNER_PRINCIPAL} namespaces=\"{SIGNATURE_NAMESPACE}\" {RUNTIME_SIGNING_KEY}\n")
    }

    fn url(&self, tag: &str, name: &str) -> String {
        format!("{}/{tag}/{name}", self.base_url)
    }
}

/// The release asset for this build's platform.
fn asset_name() -> Result<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "terminalx-serve-linux-x64",
        ("linux", "aarch64") => "terminalx-serve-linux-arm64",
        ("macos", "aarch64") => "terminalx-serve-macos-arm64",
        (os, arch) => bail!("there is no TerminalX runtime release for {os} on {arch}"),
    })
}

/// The version `current` points at (`versions/<version>`).
fn installed_version(root: &Path) -> Result<semver::Version> {
    let current = root.join("current");
    let target = std::fs::read_link(&current).map_err(|_| {
        anyhow!("{} is not a link to an installed version: this runtime was not installed by the TerminalX installer, so update it the way it was installed", current.display())
    })?;
    let name = target.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    semver::Version::parse(name).map_err(|_| anyhow!("{} points at {}, which is not a version folder", current.display(), target.display()))
}

/// A signed runtime release.
#[derive(Debug, PartialEq, Eq)]
struct Release {
    tag: String,
    version: semver::Version,
    /// The commit time in the tag (`YYYYMMDDHHMMSS`), which orders builds.
    built: u64,
}

/// `runtime-v<version>-<14-digit time>-<7 hex>`, as `release-serve.yml` names
/// tags (the installer's `TAG_PATTERN`).
fn parse_tag(tag: &str) -> Option<Release> {
    let rest = tag.strip_prefix("runtime-v")?;
    let mut parts = rest.split('-');
    let (version, built, commit) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || built.len() != 14 || !built.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if commit.len() != 7 || !commit.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let version = semver::Version::parse(version).ok().filter(|version| version.pre.is_empty() && version.build.is_empty())?;
    Some(Release { tag: tag.into(), version, built: built.parse().ok()? })
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
}

/// The newest release in a GitHub releases list that is signed and carries
/// `asset`, by build time.
fn newest_signed(list: &[u8], asset: &str) -> Result<Option<Release>> {
    let releases: Vec<GithubRelease> = serde_json::from_slice(list).context("the releases list is not readable")?;
    Ok(releases
        .into_iter()
        .filter(|release| !release.draft)
        .filter(|release| [asset, SUMS, SIGNATURE, MANIFEST].iter().all(|name| release.assets.iter().any(|carried| carried.name == *name)))
        .filter_map(|release| parse_tag(&release.tag_name))
        .max_by_key(|release| (release.built, release.version.clone())))
}

/// The SHA-256 `SHA256SUMS` lists for `name`, in hex.
fn listed_hash(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.split_once(char::is_whitespace)?;
        let file = file.trim_start().trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

/// Check `signature` over `sums` with `ssh-keygen -Y verify`, trusting only
/// `signers`.
fn verify_signature(sums: &[u8], signature: &[u8], signers: &str, scratch: &Path) -> Result<()> {
    let signers_path = scratch.join("allowed_signers");
    let signature_path = scratch.join(SIGNATURE);
    std::fs::write(&signers_path, signers)?;
    std::fs::write(&signature_path, signature)?;
    let mut child = Command::new("ssh-keygen")
        .args(["-Y", "verify", "-f"])
        .arg(&signers_path)
        .args(["-I", SIGNER_PRINCIPAL, "-n", SIGNATURE_NAMESPACE, "-s"])
        .arg(&signature_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("run ssh-keygen to check the release signature (install OpenSSH 8.1 or later)")?;
    std::io::Write::write_all(child.stdin.as_mut().expect("piped stdin"), sums)?;
    drop(child.stdin.take());
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        bail!("the signature does not verify against the TerminalX release key ({}); the release was refused and nothing was changed", said.trim());
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn download(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>> {
    let response = agent.get(url).call().map_err(|error| match error {
        ureq::Error::Status(status, _) => anyhow!("{url} answered {status}"),
        ureq::Error::Transport(error) => anyhow!("cannot download {url}: {error}"),
    })?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(response.into_reader(), MAX_DOWNLOAD + 1), &mut bytes)?;
    if bytes.len() as u64 > MAX_DOWNLOAD {
        bail!("{url} is larger than any runtime release");
    }
    Ok(bytes)
}

/// Download, check and install `release` under `root`, then point `current`
/// at it. Returns the version folder. Nothing in `root` changes unless every
/// check passes.
fn apply(root: &Path, source: &Source, release: &Release, asset: &str, fetch: &dyn Fn(&str) -> Result<Vec<u8>>) -> Result<PathBuf> {
    let tag = &release.tag;
    let versions = root.join("versions");
    std::fs::create_dir_all(&versions).with_context(|| format!("create {}", versions.display()))?;
    let scratch = tempfile::Builder::new().prefix(".update.").tempdir_in(&versions).context("make a staging folder")?;

    let sums = fetch(&source.url(tag, SUMS)).with_context(|| format!("download {SUMS} of {tag}"))?;
    let signature = fetch(&source.url(tag, SIGNATURE)).map_err(|_| anyhow!("{tag} has no signature ({SIGNATURE}) and is refused; nothing was changed"))?;
    verify_signature(&sums, &signature, &source.signers, scratch.path())?;
    let sums = String::from_utf8(sums).context("SHA256SUMS is not text")?;

    let checked = |name: &str| -> Result<Vec<u8>> {
        let expected = listed_hash(&sums, name).ok_or_else(|| anyhow!("{SUMS} of {tag} does not list {name}; nothing was changed"))?;
        let bytes = fetch(&source.url(tag, name)).with_context(|| format!("download {name} of {tag}"))?;
        let actual = sha256_hex(&bytes);
        if actual != expected {
            bail!("{name} of {tag} does not match its signed SHA-256 (expected {expected}, got {actual}); it was refused and nothing was changed");
        }
        Ok(bytes)
    };
    let manifest: serde_json::Value = serde_json::from_slice(&checked(MANIFEST)?).context("terminalx-serve.json is not JSON")?;
    if manifest["version"].as_str() != Some(release.version.to_string().as_str()) {
        bail!("{tag} carries version {} in {MANIFEST}, which does not match its tag; nothing was changed", manifest["version"]);
    }
    let binary = checked(asset)?;

    let staged = scratch.path().join("terminalx-serve");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o755);
        let mut file = options.open(&staged)?;
        std::io::Write::write_all(&mut file, &binary)?;
        file.sync_all()?;
    }
    let ran = Command::new(&staged).arg("--version").stdin(Stdio::null()).output().with_context(|| format!("run the downloaded runtime of {tag}"))?;
    let said = String::from_utf8_lossy(&ran.stdout).trim().to_string();
    let expected = format!("terminalx-serve {}", release.version);
    if !ran.status.success() || said != expected {
        bail!("the downloaded runtime says {said:?}, not {expected:?}; nothing was changed");
    }

    let dest = versions.join(release.version.to_string());
    if dest.exists() {
        // Another build of an installed version: swap the binary in one
        // rename, so a running process keeps the file it started from.
        std::fs::rename(&staged, dest.join("terminalx-serve")).with_context(|| format!("replace {}", dest.display()))?;
    } else {
        std::fs::create_dir(&dest).with_context(|| format!("create {}", dest.display()))?;
        #[cfg(unix)]
        std::fs::set_permissions(&dest, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
        std::fs::rename(&staged, dest.join("terminalx-serve")).with_context(|| format!("move the runtime into {}", dest.display()))?;
    }
    swap_link(&root.join("current"), &Path::new("versions").join(release.version.to_string()))?;
    Ok(dest)
}

/// Point the symlink `link` at `target` in one rename.
fn swap_link(link: &Path, target: &Path) -> Result<()> {
    let next = link.with_file_name(format!(".current.next.{}", std::process::id()));
    let _ = std::fs::remove_file(&next);
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, &next).with_context(|| format!("create {}", next.display()))?;
    std::fs::rename(&next, link).inspect_err(|_| {
        let _ = std::fs::remove_file(&next);
    })
    .with_context(|| format!("swap {} to {}", link.display(), target.display()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const TAG: &str = "runtime-v9.9.9-20261116120000-abcdef1";
    const ASSET: &str = "terminalx-serve-linux-x64";

    #[test]
    fn tags_are_read_as_the_release_workflow_names_them() {
        let release = parse_tag(TAG).unwrap();
        assert_eq!((release.version.to_string(), release.built), ("9.9.9".into(), 20261116120000));
        for bad in ["runtime-v9.9.9-2026111612000-abcdef1", "runtime-v9.9-20261116120000-abcdef1", "runtime-v9.9.9-20261116120000-ABCDEF1", "v9.9.9", "runtime-v9.9.9-rc1-20261116120000-abcdef1"] {
            assert_eq!(parse_tag(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_newest_signed_release_with_this_asset_is_chosen() {
        let release = |tag: &str, assets: &[&str]| serde_json::json!({ "tag_name": tag, "draft": false, "assets": assets.iter().map(|name| serde_json::json!({ "name": name })).collect::<Vec<_>>() });
        let all = [ASSET, SUMS, SIGNATURE, MANIFEST];
        let list = serde_json::json!([
            release("runtime-v9.9.8-20261116130000-abcdef2", &[ASSET, SUMS, MANIFEST]),
            release("runtime-v9.9.9-20261116140000-abcdef3", &["terminalx-serve-linux-arm64", SUMS, SIGNATURE, MANIFEST]),
            release(TAG, &all),
            release("runtime-v9.9.7-20261115120000-abcdef4", &all),
            release("terminalx-v0.2.30", &all),
        ]);
        let newest = newest_signed(list.to_string().as_bytes(), ASSET).unwrap().unwrap();
        assert_eq!(newest.tag, TAG, "unsigned and other-platform releases are skipped");
        assert_eq!(newest_signed(b"[]", ASSET).unwrap(), None);
    }

    #[test]
    fn sums_are_read_in_either_mode() {
        let hash = "a".repeat(64);
        assert_eq!(listed_hash(&format!("{hash}  {ASSET}\n"), ASSET), Some(hash.clone()));
        assert_eq!(listed_hash(&format!("{hash} *{ASSET}\n"), ASSET), Some(hash.clone()));
        assert_eq!(listed_hash(&format!("{hash}  {ASSET}.old\n"), ASSET), None);
    }

    /// A release of a stand-in runtime signed with a throwaway key, served by
    /// `fetch`, and an install of 1.0.0 to update.
    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        files: HashMap<String, Vec<u8>>,
        source: Source,
        key: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("install");
            std::fs::create_dir_all(root.join("versions/1.0.0")).unwrap();
            std::fs::write(root.join("versions/1.0.0/terminalx-serve"), "old").unwrap();
            std::os::unix::fs::symlink("versions/1.0.0", root.join("current")).unwrap();
            let key = dir.path().join("key");
            let made = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f"]).arg(&key).status().unwrap();
            assert!(made.success());
            let public = std::fs::read_to_string(key.with_extension("pub")).unwrap();
            let public = public.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
            let signers = format!("{SIGNER_PRINCIPAL} namespaces=\"{SIGNATURE_NAMESPACE}\" {public}\n");
            let source = Source { api_url: "test:list".into(), base_url: "test:".into(), signers };
            let mut fixture = Self { _dir: dir, root, files: HashMap::new(), source, key };
            fixture.publish(b"#!/bin/sh\necho 'terminalx-serve 9.9.9'\n", "9.9.9");
            fixture
        }

        fn publish(&mut self, binary: &[u8], manifest_version: &str) {
            let manifest = serde_json::json!({ "version": manifest_version }).to_string().into_bytes();
            let sums = format!("{}  {ASSET}\n{}  {MANIFEST}\n", sha256_hex(binary), sha256_hex(&manifest));
            self.files.insert(self.source.url(TAG, ASSET), binary.to_vec());
            self.files.insert(self.source.url(TAG, MANIFEST), manifest);
            self.sign(sums.as_bytes(), &self.key.clone());
        }

        fn sign(&mut self, sums: &[u8], key: &Path) {
            let scratch = tempfile::tempdir().unwrap();
            let file = scratch.path().join(SUMS);
            std::fs::write(&file, sums).unwrap();
            let signed = Command::new("ssh-keygen").args(["-q", "-Y", "sign", "-n", SIGNATURE_NAMESPACE, "-f"]).arg(key).arg(&file).status().unwrap();
            assert!(signed.success());
            self.files.insert(self.source.url(TAG, SUMS), sums.to_vec());
            self.files.insert(self.source.url(TAG, SIGNATURE), std::fs::read(scratch.path().join(format!("{SUMS}.sig"))).unwrap());
        }

        fn apply(&self) -> Result<PathBuf> {
            let files = self.files.clone();
            let fetch = move |url: &str| files.get(url).cloned().ok_or_else(|| anyhow!("{url} answered 404"));
            apply(&self.root, &self.source, &parse_tag(TAG).unwrap(), ASSET, &fetch)
        }

        fn current(&self) -> PathBuf {
            std::fs::read_link(self.root.join("current")).unwrap()
        }

        /// Nothing changed: `current` and the version folders are as before.
        fn assert_unchanged(&self) {
            assert_eq!(self.current(), Path::new("versions/1.0.0"));
            let mut left: Vec<_> = std::fs::read_dir(self.root.join("versions")).unwrap().map(|entry| entry.unwrap().file_name()).collect();
            left.sort();
            assert_eq!(left, ["1.0.0"], "no staging folder or new version is left behind");
        }
    }

    #[test]
    fn a_signed_release_is_installed_beside_the_old_one() {
        let fixture = Fixture::new();
        assert_eq!(installed_version(&fixture.root).unwrap().to_string(), "1.0.0");
        let dest = fixture.apply().unwrap();
        assert_eq!(dest, fixture.root.join("versions/9.9.9"));
        assert_eq!(fixture.current(), Path::new("versions/9.9.9"));
        assert_eq!(installed_version(&fixture.root).unwrap().to_string(), "9.9.9");
        assert!(fixture.root.join("versions/1.0.0/terminalx-serve").exists(), "the old version stays for a rollback");
        let names: Vec<_> = std::fs::read_dir(fixture.root.join("versions")).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        assert!(names.iter().all(|name| !name.starts_with('.')), "the staging folder is removed: {names:?}");
    }

    #[test]
    fn a_release_signed_by_another_key_is_refused() {
        let mut fixture = Fixture::new();
        let other = fixture._dir.path().join("other");
        assert!(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&other).status().unwrap().success());
        let sums = fixture.files[&fixture.source.url(TAG, SUMS)].clone();
        fixture.sign(&sums, &other);
        let error = fixture.apply().unwrap_err();
        assert!(format!("{error:#}").contains("does not verify"), "{error:#}");
        fixture.assert_unchanged();
    }

    #[test]
    fn an_unsigned_release_is_refused() {
        let mut fixture = Fixture::new();
        fixture.files.remove(&fixture.source.url(TAG, SIGNATURE));
        assert!(format!("{:#}", fixture.apply().unwrap_err()).contains("has no signature"));
        fixture.assert_unchanged();
    }

    #[test]
    fn a_binary_that_does_not_match_its_signed_hash_is_refused() {
        let mut fixture = Fixture::new();
        fixture.files.insert(fixture.source.url(TAG, ASSET), b"#!/bin/sh\necho 'terminalx-serve 9.9.9' # changed\n".to_vec());
        assert!(format!("{:#}", fixture.apply().unwrap_err()).contains("does not match its signed SHA-256"));
        fixture.assert_unchanged();
    }

    #[test]
    fn a_runtime_that_is_not_the_version_it_claims_is_refused() {
        let mut fixture = Fixture::new();
        fixture.publish(b"#!/bin/sh\necho 'terminalx-serve 1.0.0'\n", "9.9.9");
        assert!(format!("{:#}", fixture.apply().unwrap_err()).contains("not \"terminalx-serve 9.9.9\""));
        fixture.assert_unchanged();
        fixture.publish(b"#!/bin/sh\necho 'terminalx-serve 9.9.9'\n", "9.9.8");
        assert!(format!("{:#}", fixture.apply().unwrap_err()).contains("does not match its tag"));
        fixture.assert_unchanged();
    }

    #[test]
    fn the_compiled_in_key_is_the_release_key() {
        assert_eq!(Source::release_signers().trim(), include_str!("../../../scripts/install/allowed_signers").lines().find(|line| !line.trim().is_empty() && !line.starts_with('#')).unwrap().trim());
    }
}
