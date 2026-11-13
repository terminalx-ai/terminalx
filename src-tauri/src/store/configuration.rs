//! Layered settings supported independently of PRO-131/140/149. The registry is
//! deliberately opt-in: adding a field to Settings never gives a repository
//! permission to set it. No scripts are executed by this module.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use super::config_files::Directory;

pub const SHARED: &str = "settings.json";
pub const LOCAL: &str = "settings.local.json";
const TRUST: &str = "repository-trust.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Layer { Defaults, User, RepositoryShared, RepositoryLocal, Managed }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub key: &'static str,
    pub repository_configurable: bool,
    pub managed_lockable: bool,
    pub requires_trust: bool,
}
// Filesystem locations stay machine-specific until the settings-file migration.
// branchPrefix also controls cleanup candidates, hence trust. sparseCheckout
// only narrows what a new workspace checks out and executes nothing.
pub const REGISTRY: &[Key] = &[
    Key { key: "worktreeDir", repository_configurable: false, managed_lockable: false, requires_trust: false },
    Key { key: "branchPrefix", repository_configurable: true, managed_lockable: true, requires_trust: true },
    Key { key: "environment", repository_configurable: true, managed_lockable: true, requires_trust: true },
    Key { key: "sparseCheckout", repository_configurable: true, managed_lockable: true, requires_trust: false },
];

/// Most folders one `sparseCheckout` list may name.
pub const SPARSE_CHECKOUT_MAX_FOLDERS: usize = 1000;
/// Longest folder path, in bytes, a `sparseCheckout` list may name.
pub const SPARSE_CHECKOUT_MAX_PATH: usize = 1024;

/// A repository-relative folder as `git sparse-checkout set --cone --stdin`
/// takes it: `/`-separated, no leading or trailing slash, no empty, `.` or
/// `..` segment, and no `*`, `?`, backslash or line break. Git escapes `[`
/// and `]` in cone-mode folders (Next.js's `app/[locale]` checks out as
/// itself), and a `!` is never at the start of the `/folder/` patterns it
/// writes; a `*` collides with cone mode's own `/folder/*/` patterns and turns it off.
pub fn valid_sparse_folder(path: &str) -> bool {
    !path.is_empty() && path.len() <= SPARSE_CHECKOUT_MAX_PATH
        && !path.chars().any(|c| c.is_control() || matches!(c, '\\' | '*' | '?'))
        && path.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn valid_sparse_checkout(value: &Value) -> bool {
    let Some(folders) = value.as_array() else { return false };
    let mut seen = std::collections::BTreeSet::new();
    folders.len() <= SPARSE_CHECKOUT_MAX_FOLDERS
        && folders.iter().all(|folder| folder.as_str().is_some_and(|folder| valid_sparse_folder(folder) && seen.insert(folder)))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedValue {
    pub value: Value,
    pub source: Layer,
    pub locked: bool,
    pub redacted: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub values: BTreeMap<String, ResolvedValue>,
    pub registry: &'static [Key],
    pub warnings: Vec<String>,
    pub trust: Option<Trust>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trust {
    pub hash: String,
    pub required: bool,
    pub keys: Vec<String>,
}

pub struct Repository { pub root: PathBuf, identity: String }

/// No hooks, fsmonitor, inherited Git discovery variables or shell are used to
/// discover the checkout. All workspaces inherit the primary checkout's files.
fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = std::process::Command::new(crate::binpath::resolve("git").unwrap_or_else(|| PathBuf::from("git")))
        .env("GIT_NO_LAZY_FETCH", "1").current_dir(root).env_remove("GIT_DIR").env_remove("GIT_COMMON_DIR").env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE").env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .args(["-c", "core.fsmonitor=false"]).args(args).output()?;
    ensure!(output.status.success(), "Cannot read repository configuration metadata.");
    Ok(String::from_utf8(output.stdout)?.trim().into())
}
pub fn repository(path: &Path) -> Result<Repository> {
    let checkout = PathBuf::from(git(path, &["rev-parse", "--show-toplevel"])?).canonicalize()?;
    let common = PathBuf::from(git(&checkout, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?).canonicalize()?;
    // Configuration belongs to the primary checkout, including local overrides.
    // A linked workspace must not silently lose ignored local values or adopt
    // executable settings from an arbitrary branch it checks out.
    let worktrees = git(&checkout, &["worktree", "list", "--porcelain", "-z"])?;
    let primary = worktrees.split('\0').find_map(|line| line.strip_prefix("worktree ")).context("Repository has no primary checkout.")?;
    let root = PathBuf::from(primary).canonicalize()?;
    Ok(Repository { root, identity: common.to_string_lossy().into_owned() })
}
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn object(bytes: &[u8]) -> Result<Map<String, Value>> {
    serde_json::from_slice::<Value>(bytes).ok().and_then(|v| v.as_object().cloned())
        .context("Configuration must be a JSON object.")
}
fn read(dir: Option<&Directory>, name: &str) -> Result<Option<Vec<u8>>> {
    dir.map(|dir| dir.read(name)).transpose().map(Option::flatten)
}
fn record_warning(warnings: &mut Vec<String>, layer: Layer, key: &str) {
    // Only key names, never values or parser excerpts (environment may be secret).
    let key: String = key.chars().filter(|c| !c.is_control()).take(100).collect();
    let warning = format!("Ignored unsupported or invalid {layer:?} setting: {key}");
    log::warn!("{warning}");
    warnings.push(warning);
}
fn valid(key: &str, value: &Value, layer: Layer) -> bool {
    match key {
        "branchPrefix" => value.as_str().is_some_and(|s| (layer == Layer::User || s.is_empty()) || s.len() <= 128
            && s.split('/').filter(|p| !p.is_empty()).all(|p| !p.starts_with('-') && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
            && !s.starts_with('/') && !s.contains("//")),
        "worktreeDir" => value.is_string(),
        "sparseCheckout" => valid_sparse_checkout(value),
        "environment" => value.as_object().is_some_and(|env| env.len() <= 256 && env.iter().all(|(name, value)| {
            super::environment::validate_name(name).is_ok() && value.as_str().is_some_and(|s| s.len() <= 64 * 1024 && !s.contains('\0'))
        })),
        _ => false
    }
}
fn apply(values: &mut BTreeMap<String, ResolvedValue>, document: Map<String, Value>, layer: Layer, warnings: &mut Vec<String>) -> Result<()> {
    for (key, value) in document {
        let registration = REGISTRY.iter().find(|r| r.key == key);
        let allowed = registration.is_some_and(|r| match layer {
            Layer::RepositoryLocal | Layer::RepositoryShared => r.repository_configurable,
            Layer::Managed => r.managed_lockable,
            // A folder list names one repository's folders; a user-wide one would
            // narrow every repository's workspaces to folders it may not have.
            Layer::User => r.key != "environment" && r.key != "sparseCheckout",
            _ => true,
        });
        if !allowed || !valid(&key, &value, layer) {
            if layer == Layer::Managed { bail!("Managed configuration contains an unsupported or invalid setting."); }
            // The user file belongs to Settings; other registered UI fields are legitimate there.
            if layer != Layer::User || registration.is_some() { record_warning(warnings, layer, &key); }
            continue;
        }
        let entries = if key == "environment" {
            value.as_object().unwrap().iter().map(|(name, value)| (format!("environment.{name}"), value.clone())).collect()
        } else { vec![(key, value)] };
        for (key, value) in entries {
            values.insert(key, ResolvedValue { value, source: layer, locked: layer == Layer::Managed, redacted: false });
        }
    }
    Ok(())
}

pub struct Store {
    home: PathBuf,
    // Only resolver fixtures bypass ownership checks; production has no path override.
    #[cfg(test)]
    managed_fixture: Option<PathBuf>,
}
impl Store {
    pub fn current() -> Result<Self> { Ok(Self { home: super::root()?.canonicalize()?, #[cfg(test)] managed_fixture: None }) }
    fn managed(&self) -> Result<Option<Vec<u8>>> {
        #[cfg(test)]
        if let Some(path) = &self.managed_fixture {
            return match std::fs::read(path) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            };
        }
        super::managed_configuration::read()
    }
    fn home(&self) -> Result<Directory> { Directory::open(&self.home, false)?.context("Settings directory is missing.") }
    fn trusted(&self, repository: &Repository, hash: &str) -> bool {
        self.home().and_then(|dir| dir.read(TRUST)).ok().flatten()
            .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, String>>(&bytes).ok())
            .is_some_and(|trust| trust.get(&repository.identity).is_some_and(|saved| saved == hash))
    }
    pub fn resolve(&self, repository: Option<&Repository>) -> Result<Resolution> {
        let home = self.home()?;
        let defaults = super::settings::Settings::default();
        let mut values = BTreeMap::new();
        let mut warnings = Vec::new();
        apply(&mut values, json!({"worktreeDir": defaults.worktree_dir, "branchPrefix": defaults.branch_prefix}).as_object().unwrap().clone(), Layer::Defaults, &mut warnings)?;
        if let Some(bytes) = home.read(SHARED)? {
            match object(&bytes) {
                // settings::file recovers each field independently, so one
                // invalid sibling does not discard a valid worktree path here.
                Ok(user) => apply(&mut values, user, Layer::User, &mut warnings)?,
                Err(_) => record_warning(&mut warnings, Layer::User, "file (malformed)"),
            }
        }
        let mut trust = None;
        if let Some(repository) = repository {
            let dir = Directory::open(&repository.root.join(".terminalx"), false)?;
            if let Some(bytes) = read(dir.as_ref(), SHARED)? {
                let hash = digest(&bytes);
                match object(&bytes) {
                    Ok(shared) => {
                        apply(&mut values, shared, Layer::RepositoryShared, &mut warnings)?;
                        trust = Some(Trust { required: !self.trusted(repository, &hash), hash, keys: Vec::new() });
                    }
                    Err(_) => record_warning(&mut warnings, Layer::RepositoryShared, "file (malformed)"),
                }
            }
            if let Some(bytes) = read(dir.as_ref(), LOCAL)? {
                // An accidentally committed 'local' file is still untrusted input.
                ensure!(git(&repository.root, &["ls-files", "--", ".terminalx/settings.local.json"])?.is_empty(), "Repository local settings must not be tracked by Git.");
                ensure!(git(&repository.root, &["check-ignore", "--no-index", ".terminalx/settings.local.json"]).is_ok(), "Repository local settings must be ignored by Git.");
                apply(&mut values, object(&bytes)?, Layer::RepositoryLocal, &mut warnings)?;
            }
        }
        if let Some(bytes) = self.managed()? {
            apply(&mut values, object(&bytes).context("Invalid managed configuration; refusing to bypass policy.")?, Layer::Managed, &mut warnings)?;
        }
        if let Some(trust) = &mut trust {
            trust.keys = values.iter().filter(|(key, value)| value.source == Layer::RepositoryShared && REGISTRY.iter().any(|r| r.requires_trust && (*key == r.key || key.starts_with(&format!("{}.", r.key)))))
                .map(|(key, _)| key.clone()).collect();
            trust.required &= !trust.keys.is_empty();
        }
        Ok(Resolution { values, registry: REGISTRY, warnings, trust })
    }

    /// Called only after the native consent dialog answered affirmatively.
    /// Re-read the file: approving yesterday's bytes cannot trust today's commands.
    pub fn trust(&self, repository: &Repository, expected_hash: &str) -> Result<()> {
        super::transaction::run(&self.home.join("configuration.lock"), Duration::from_secs(10), || {
            let dir = Directory::open(&repository.root.join(".terminalx"), false)?.context("Shared configuration disappeared.")?;
            let bytes = dir.read(SHARED)?.context("Shared configuration disappeared.")?;
            object(&bytes)?;
            ensure!(digest(&bytes) == expected_hash, "Shared configuration changed. Review it again.");
            let home = self.home()?;
            let mut trust: BTreeMap<String, String> = match home.read(TRUST)? {
                Some(bytes) => serde_json::from_slice(&bytes).context("Cannot read repository trust decisions.")?,
                None => BTreeMap::new(),
            };
            trust.insert(repository.identity.clone(), expected_hash.into());
            home.write(TRUST, &serde_json::to_vec_pretty(&trust)?)
        })
    }

    pub fn write(&self, repository: Option<&Repository>, layer: Layer, key: &str, value: Option<Value>) -> Result<()> {
        ensure!(matches!(layer, Layer::User | Layer::RepositoryLocal | Layer::RepositoryShared), "Managed values are read-only.");
        let registration = REGISTRY.iter().find(|r| r.key == key).context("Unknown configuration key.")?;
        ensure!(layer == Layer::User || registration.repository_configurable, "This key cannot be set by a repository.");
        // Secret environment writes remain in the existing Keychain editor. File
        // environment is deliberately authored/reviewed explicitly, never migrated.
        ensure!(key != "environment", "Edit file environment explicitly; use Settings → Environment for private variables.");
        ensure!(value.as_ref().is_none_or(|v| valid(key, v, Layer::RepositoryLocal)), "Invalid configuration value.");
        // The user layer is settings.json: serialize with every other writer
        // of that file (settings::file), which locks settings.lock.
        let lock = if layer == Layer::User { "settings.lock" } else { "configuration.lock" };
        super::transaction::run(&self.home.join(lock), Duration::from_secs(10), || {
            let resolved = self.resolve(repository)?;
            ensure!(!resolved.values.get(key).is_some_and(|value| value.locked), "This setting is locked by managed configuration.");
            let dir = if layer == Layer::User { self.home()? } else {
                let repository = repository.context("Choose a local Git repository.")?;
                let dir = Directory::open(&repository.root.join(".terminalx"), true)?.context("Configuration directory is missing.")?;
                if layer == Layer::RepositoryLocal {
                    ensure!(git(&repository.root, &["ls-files", "--", ".terminalx/settings.local.json"])?.is_empty(), "Local configuration is tracked. Remove it from Git before saving.");
                    let mut ignore = String::from_utf8(dir.read(".gitignore")?.unwrap_or_default())?;
                    if !ignore.lines().any(|line| line == "/settings.local.json") {
                        ignore.push_str("\n/settings.local.json\n");
                        dir.write(".gitignore", ignore.as_bytes())?;
                    }
                    ensure!(git(&repository.root, &["check-ignore", "--no-index", ".terminalx/settings.local.json"]).is_ok(), "Local configuration must be ignored by Git.");
                }
                dir
            };
            let file = if layer == Layer::RepositoryLocal { LOCAL } else { SHARED };
            let mut document = match dir.read(file)? { Some(bytes) => object(&bytes)?, None => Map::new() };
            if let Some(value) = value { document.insert(key.into(), value); } else { document.remove(key); }
            dir.write(file, &serde_json::to_vec_pretty(&document)?)
        })
    }
}
impl Resolution {
    pub(super) fn refresh_trust(&mut self) {
        if let Some(trust) = &mut self.trust {
            trust.keys.retain(|key| self.values.get(key).is_some_and(|value| value.source == Layer::RepositoryShared));
            trust.required &= !trust.keys.is_empty();
        }
    }
    pub fn require_trust(&self) -> Result<()> {
        ensure!(!self.trust.as_ref().is_some_and(|trust| trust.required), "Repository configuration needs trust. Open Settings → General → Layered configuration and review this repository before starting work.");
        Ok(())
    }
    pub fn redacted(mut self) -> Self {
        for (key, value) in &mut self.values {
            if key.starts_with("environment.") { value.value = Value::Null; value.redacted = true; }
        }
        self
    }
}
pub fn resolve(project: Option<&str>) -> Result<Resolution> {
    let repository = project.map(|path| repository(Path::new(path))).transpose()?;
    Store::current()?.resolve(repository.as_ref())
}
/// Read surfaces add Keychain names/sources, never their private values.
pub fn view(project: Option<&str>) -> Result<Resolution> {
    Ok(with_private_sources(project, resolve(project)?).redacted())
}

/// Keep raw shared values inside native code for the hash-bound consent review.
pub(crate) fn with_private_sources(project: Option<&str>, mut resolved: Resolution) -> Resolution {
    if super::environment::configuration_sources(project, &mut resolved.values).is_err() {
        // Preserve ordinary launches' existing missing-Keychain fallback. A
        // layered environment still fails closed at launch; absent metadata
        // never suppresses the shared-file consent requirement.
        let warning = "Private environment sources are unavailable.".to_string();
        log::warn!("{warning}");
        resolved.warnings.push(warning);
    }
    resolved.refresh_trust();
    resolved
}

/// The folders a new workspace of `project` checks out, or `None` for a full
/// checkout. Read like `branch_prefix`, from the primary checkout's layers.
pub fn sparse_checkout(project: &Path) -> Result<Option<Vec<String>>> {
    let resolved = view(Some(project.to_str().context("Repository path must be UTF-8.")?))?;
    let Some(value) = resolved.values.get("sparseCheckout") else { return Ok(None) };
    let folders = value.value.as_array().context("Invalid sparse checkout folders.")?;
    folders.iter().map(|folder| folder.as_str().map(str::to_owned).context("Invalid sparse checkout folder.")).collect::<Result<Vec<_>>>().map(Some)
}

/// Policy/read failures are errors, never an empty prefix that could classify
/// arbitrary user branches as managed workspaces.
pub fn branch_prefix(project: &Path) -> Result<String> {
    let resolved = view(Some(project.to_str().context("Repository path must be UTF-8.")?))?;
    resolved.require_trust()?;
    resolved.values["branchPrefix"].value.as_str().map(str::to_owned).context("Invalid branch prefix.")
}

#[cfg(test)]
#[path = "configuration_tests.rs"]
mod tests;
