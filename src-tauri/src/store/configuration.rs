//! Layered settings supported independently of PRO-131/140. The registry is
//! deliberately opt-in: adding a field to Settings never gives a repository
//! permission to set it. No scripts are executed by this module: [`scripts`]
//! only says which setup and archive commands a repository's hooks may run.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use super::config_files::Directory;
use super::settings::file::{display_path, member_lines, parser_words, Effect, Problem};
use super::settings::schema;

pub const SHARED: &str = "settings.json";
pub const LOCAL: &str = "settings.local.json";
const TRUST: &str = "repository-trust.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Layer { Defaults, User, RepositoryShared, RepositoryLocal, Managed }

/// One layer's own value for a key (`ConfigurationLayerValue` in src/types/configuration.ts).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayerValue { pub layer: Layer, pub value: Value, pub redacted: bool }
/// Every layer that supplies each key, lowest first while resolving.
type Layers = BTreeMap<String, Vec<LayerValue>>;

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
    // Scripts run commands, so a committed value needs trust. The user layer for
    // them is the per-repository project store, never the global settings file.
    Key { key: SETUP_SCRIPT, repository_configurable: true, managed_lockable: true, requires_trust: true },
    Key { key: ARCHIVE_SCRIPT, repository_configurable: true, managed_lockable: true, requires_trust: true },
    Key { key: ARCHIVE_TIMEOUT, repository_configurable: true, managed_lockable: true, requires_trust: false },
];
pub const SETUP_SCRIPT: &str = "setupScript";
pub const ARCHIVE_SCRIPT: &str = "archiveScript";
pub const ARCHIVE_TIMEOUT: &str = "archiveTimeoutMinutes";
/// The archive timeouts Settings offers; anything else in a file is ignored.
pub const ARCHIVE_TIMEOUT_CHOICES: &[u64] = &[1, 2, 5, 10, 15, 30];
pub const DEFAULT_ARCHIVE_TIMEOUT_MINUTES: u64 = 5;
const SCRIPT_LIMIT: usize = 64 * 1024;
fn per_repository(key: &str) -> bool { matches!(key, SETUP_SCRIPT | ARCHIVE_SCRIPT | ARCHIVE_TIMEOUT) }

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

/// [`valid_sparse_folder`] as a pattern for the published repository schema:
/// `/`-separated segments that are neither `.` nor `..`, without control
/// characters, `\\`, `*` or `?`. The schema test checks the two agree.
#[cfg(test)]
const SPARSE_FOLDER_PATTERN: &str = r"^(?:[^./\\*?\x00-\x1f\x7f-\x9f][^/\\*?\x00-\x1f\x7f-\x9f]*|\.[^./\\*?\x00-\x1f\x7f-\x9f][^/\\*?\x00-\x1f\x7f-\x9f]*|\.\.[^/\\*?\x00-\x1f\x7f-\x9f]+)(?:/(?:[^./\\*?\x00-\x1f\x7f-\x9f][^/\\*?\x00-\x1f\x7f-\x9f]*|\.[^./\\*?\x00-\x1f\x7f-\x9f][^/\\*?\x00-\x1f\x7f-\x9f]*|\.\.[^/\\*?\x00-\x1f\x7f-\x9f]+))*$";

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

pub struct Repository {
    pub root: PathBuf,
    identity: String,
    /// The path asked about: the project whose saved scripts are its user layer.
    project: PathBuf,
}

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
    Ok(Repository { root, identity: common.to_string_lossy().into_owned(), project: path.canonicalize().unwrap_or_else(|_| path.to_path_buf()) })
}
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
/// What trust is bound to. A file that sets scripts gets a hash no earlier
/// version produced: before scripts were registered, trusting a file never
/// showed or approved them, so that approval must not let them run now.
fn trust_hash(bytes: &[u8], document: &Map<String, Value>) -> String {
    if document.contains_key(SETUP_SCRIPT) || document.contains_key(ARCHIVE_SCRIPT) {
        digest(&[b"terminalx-trust-scripts-v1\0".as_slice(), bytes].concat())
    } else { digest(bytes) }
}
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
/// A branch prefix a repository or policy may set: slash-separated components
/// of ASCII letters, digits, hyphens and underscores, none starting with a
/// hyphen, optionally ending in a slash; empty disables prefix-based cleanup.
/// `valid` and the published repository schema both read this pattern.
const BRANCH_PREFIX_PATTERN: &str = "^(?:[A-Za-z0-9_][A-Za-z0-9_-]*(?:/[A-Za-z0-9_][A-Za-z0-9_-]*)*/?)?$";
const BRANCH_PREFIX_MAX: usize = 128;
static BRANCH_PREFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(BRANCH_PREFIX_PATTERN).expect("branch prefix pattern"));
const ENVIRONMENT_MAX_VARIABLES: usize = 256;
const ENVIRONMENT_MAX_VALUE: usize = 64 * 1024;

fn valid(key: &str, value: &Value, layer: Layer) -> bool {
    match key {
        "branchPrefix" => value.as_str().is_some_and(|s| layer == Layer::User || s.len() <= BRANCH_PREFIX_MAX && BRANCH_PREFIX.is_match(s)),
        "worktreeDir" => value.is_string(),
        "sparseCheckout" => valid_sparse_checkout(value),
        "environment" => value.as_object().is_some_and(|env| env.len() <= ENVIRONMENT_MAX_VARIABLES && env.iter().all(|(name, value)| {
            super::environment::validate_name(name).is_ok() && value.as_str().is_some_and(|s| s.len() <= ENVIRONMENT_MAX_VALUE && !s.contains('\0'))
        })),
        SETUP_SCRIPT | ARCHIVE_SCRIPT => value.as_str().is_some_and(|s| s.len() <= SCRIPT_LIMIT && !s.contains('\0')),
        ARCHIVE_TIMEOUT => value.as_u64().is_some_and(|minutes| ARCHIVE_TIMEOUT_CHOICES.contains(&minutes)),
        _ => false
    }
}
/// Why a key of a layer's file does not apply, or None when it does. Editor
/// metadata (`$schema`) is not a setting and is never reported.
fn refusal(key: &str, value: &Value, layer: Layer) -> Option<&'static str> {
    if key == "$schema" { return None; }
    let registration = REGISTRY.iter().find(|r| r.key == key);
    let allowed = registration.is_some_and(|r| match layer {
        Layer::RepositoryLocal | Layer::RepositoryShared => r.repository_configurable,
        Layer::Managed => r.managed_lockable,
        // A folder list names one repository's folders; a user-wide one would
        // narrow every repository's workspaces to folders it may not have.
        Layer::User => r.key != "environment" && r.key != "sparseCheckout" && !per_repository(r.key),
        _ => true,
    });
    if !allowed { Some("isn’t a setting") }
    else if !valid(key, value, layer) { Some("isn’t a valid value") }
    else { None }
}

fn apply(values: &mut BTreeMap<String, ResolvedValue>, layers: &mut Layers, document: Map<String, Value>, layer: Layer, warnings: &mut Vec<String>) -> Result<()> {
    for (key, value) in document {
        if refusal(&key, &value, layer).is_some() {
            if layer == Layer::Managed { bail!("Managed configuration contains an unsupported or invalid setting."); }
            // The user file belongs to Settings; other registered UI fields are legitimate there.
            if layer != Layer::User || REGISTRY.iter().any(|r| r.key == key) { record_warning(warnings, layer, &key); }
            continue;
        }
        if key == "$schema" { continue; }
        let entries = if key == "environment" {
            value.as_object().unwrap().iter().map(|(name, value)| (format!("environment.{name}"), value.clone())).collect()
        } else { vec![(key, value)] };
        for (key, value) in entries {
            layers.entry(key.clone()).or_default().push(LayerValue { layer, value: value.clone(), redacted: false });
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
    #[cfg(test)]
    saved_scripts: Option<super::projects::RepositoryScripts>,
}
impl Store {
    pub fn current() -> Result<Self> { Ok(Self { home: super::root()?.canonicalize()?, #[cfg(test)] managed_fixture: None, #[cfg(test)] saved_scripts: None }) }
    /// The Scripts page's own values for this repository: its user layer.
    fn saved_scripts(&self, repository: &Repository) -> Result<super::projects::RepositoryScripts> {
        #[cfg(test)]
        if let Some(saved) = &self.saved_scripts { return Ok(saved.clone()); }
        let saved = super::projects::scripts(&repository.project)?;
        // A workspace path asks about its primary checkout's project.
        if saved == Default::default() && repository.project != repository.root { return super::projects::scripts(&repository.root) }
        Ok(saved)
    }
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
        self.resolve_layers(repository).map(|(resolution, _)| resolution)
    }

    /// The resolution, and every layer that supplied each key (lowest first).
    fn resolve_layers(&self, repository: Option<&Repository>) -> Result<(Resolution, Layers)> {
        let home = self.home()?;
        let defaults = super::settings::Settings::default();
        let mut values = BTreeMap::new();
        let mut layers = Layers::new();
        let mut warnings = Vec::new();
        apply(&mut values, &mut layers, json!({"worktreeDir": defaults.worktree_dir, "branchPrefix": defaults.branch_prefix}).as_object().unwrap().clone(), Layer::Defaults, &mut warnings)?;
        if repository.is_some() {
            apply(&mut values, &mut layers, json!({SETUP_SCRIPT: "", ARCHIVE_SCRIPT: "", ARCHIVE_TIMEOUT: DEFAULT_ARCHIVE_TIMEOUT_MINUTES}).as_object().unwrap().clone(), Layer::Defaults, &mut warnings)?;
        }
        if let Some(bytes) = home.read(SHARED)? {
            match object(&bytes) {
                // settings::file recovers each field independently, so one
                // invalid sibling does not discard a valid worktree path here.
                Ok(user) => apply(&mut values, &mut layers, user, Layer::User, &mut warnings)?,
                Err(_) => record_warning(&mut warnings, Layer::User, "file (malformed)"),
            }
        }
        let mut trust = None;
        if let Some(repository) = repository {
            let saved = self.saved_scripts(repository)?;
            let user = [(SETUP_SCRIPT, (!saved.setup.trim().is_empty()).then(|| json!(saved.setup))),
                (ARCHIVE_SCRIPT, (!saved.archive.trim().is_empty()).then(|| json!(saved.archive))),
                (ARCHIVE_TIMEOUT, saved.archive_timeout_minutes.map(|minutes| json!(minutes)))];
            for (key, value) in user {
                if let Some(value) = value.filter(|value| valid(key, value, Layer::User)) {
                    layers.entry(key.into()).or_default().push(LayerValue { layer: Layer::User, value: value.clone(), redacted: false });
                    values.insert(key.into(), ResolvedValue { value, source: Layer::User, locked: false, redacted: false });
                }
            }
            let dir = Directory::open(&repository.root.join(".terminalx"), false)?;
            if let Some(bytes) = read(dir.as_ref(), SHARED)? {
                match object(&bytes) {
                    Ok(shared) => {
                        let hash = trust_hash(&bytes, &shared);
                        apply(&mut values, &mut layers, shared, Layer::RepositoryShared, &mut warnings)?;
                        trust = Some(Trust { required: !self.trusted(repository, &hash), hash, keys: Vec::new() });
                    }
                    Err(_) => record_warning(&mut warnings, Layer::RepositoryShared, "file (malformed)"),
                }
            }
            if let Some(bytes) = read(dir.as_ref(), LOCAL)? {
                // An accidentally committed 'local' file is still untrusted input.
                ensure!(git(&repository.root, &["ls-files", "--", ".terminalx/settings.local.json"])?.is_empty(), "Repository local settings must not be tracked by Git.");
                ensure!(git(&repository.root, &["check-ignore", "--no-index", ".terminalx/settings.local.json"]).is_ok(), "Repository local settings must be ignored by Git.");
                apply(&mut values, &mut layers, object(&bytes)?, Layer::RepositoryLocal, &mut warnings)?;
            }
        }
        if let Some(bytes) = self.managed()? {
            apply(&mut values, &mut layers, object(&bytes).context("Invalid managed configuration; refusing to bypass policy.")?, Layer::Managed, &mut warnings)?;
        }
        if let Some(trust) = &mut trust {
            trust.keys = values.iter().filter(|(key, value)| value.source == Layer::RepositoryShared && REGISTRY.iter().any(|r| r.requires_trust && (*key == r.key || key.starts_with(&format!("{}.", r.key)))))
                .map(|(key, _)| key.clone()).collect();
            trust.required &= !trust.keys.is_empty();
        }
        Ok((Resolution { values, registry: REGISTRY, warnings, trust }, layers))
    }

    /// Called only after the native consent dialog answered affirmatively.
    /// Re-read the file: approving yesterday's bytes cannot trust today's commands.
    pub fn trust(&self, repository: &Repository, expected_hash: &str) -> Result<()> {
        super::transaction::run(&self.home.join("configuration.lock"), Duration::from_secs(10), || {
            let dir = Directory::open(&repository.root.join(".terminalx"), false)?.context("Shared configuration disappeared.")?;
            let bytes = dir.read(SHARED)?.context("Shared configuration disappeared.")?;
            ensure!(trust_hash(&bytes, &object(&bytes)?) == expected_hash, "Shared configuration changed. Review it again.");
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
        ensure!(layer != Layer::User || !per_repository(key), "Save this repository's own scripts from Settings → Repositories → Scripts.");
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
            // Editors check the file against the published schema; a `$schema` the person wrote stays.
            // Not the committed shared file: builds before PRO-140 take `$schema` there for an unsupported
            // setting and warn every teammate on each resolve. People may add it there themselves.
            match layer {
                Layer::User => schema::add_reference(&mut document, schema::USER_SCHEMA_REFERENCE),
                Layer::RepositoryLocal => schema::add_reference(&mut document, schema::REPOSITORY_SCHEMA_REFERENCE),
                _ => {}
            }
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

/// The archive command a repository's removal hook runs, and how long it may run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveScript {
    pub script: String,
    pub timeout: Duration,
}
fn timeout(minutes: Option<u64>) -> Duration {
    Duration::from_secs(minutes.filter(|m| ARCHIVE_TIMEOUT_CHOICES.contains(m)).unwrap_or(DEFAULT_ARCHIVE_TIMEOUT_MINUTES) * 60)
}
impl Resolution {
    /// One script after every layer. Each is trust-checked on its own: an
    /// untrusted committed archive script never stops the person's own setup
    /// script, nor the reverse. A refused script is an error, never skipped:
    /// the caller asks (archive) or reports a failed setup instead.
    fn script(&self, key: &str) -> Result<String> {
        let Some(value) = self.values.get(key) else { return Ok(String::new()) };
        let text = value.value.as_str().unwrap_or_default().to_string();
        ensure!(text.trim().is_empty() || !self.trust.as_ref().is_some_and(|trust| trust.required && trust.keys.iter().any(|k| k == key)),
            "This repository's .terminalx/settings.json sets a {} script that is not trusted yet. Open Settings → Repositories → Scripts and choose Review and trust.",
            if key == SETUP_SCRIPT { "setup" } else { "archive" });
        Ok(text)
    }
    pub fn setup_script(&self) -> Result<String> { self.script(SETUP_SCRIPT) }
    pub fn archive_script(&self) -> Result<ArchiveScript> {
        Ok(ArchiveScript { script: self.script(ARCHIVE_SCRIPT)?, timeout: timeout(self.values.get(ARCHIVE_TIMEOUT).and_then(|value| value.value.as_u64())) })
    }
}
/// Where a project's scripts come from. A folder that is not a Git checkout
/// has no repository layers, so only the project store applies; a checkout
/// whose configuration cannot be read fails rather than run less.
enum ScriptSource { Layers(Resolution), Saved(super::projects::RepositoryScripts) }
fn script_source(project: &Path) -> Result<ScriptSource> {
    match repository(project) {
        Ok(repository) => Ok(ScriptSource::Layers(Store::current()?.resolve(Some(&repository))?)),
        Err(_) if !project.join(".terminalx").exists() && !project.join(".git").exists() => Ok(ScriptSource::Saved(super::projects::scripts(project)?)),
        Err(error) => Err(error),
    }
}
/// The setup script for a project or one of its workspaces.
pub fn setup_script(project: &Path) -> Result<String> {
    match script_source(project)? {
        ScriptSource::Layers(resolved) => resolved.setup_script(),
        ScriptSource::Saved(saved) => Ok(saved.setup),
    }
}
/// The archive script and its timeout for a project or one of its workspaces.
pub fn archive_script(project: &Path) -> Result<ArchiveScript> {
    match script_source(project)? {
        ScriptSource::Layers(resolved) => resolved.archive_script(),
        ScriptSource::Saved(saved) => Ok(ArchiveScript { script: saved.archive, timeout: timeout(saved.archive_timeout_minutes) }),
    }
}

/// Policy/read failures are errors, never an empty prefix that could classify
/// arbitrary user branches as managed workspaces.
pub fn branch_prefix(project: &Path) -> Result<String> {
    let resolved = view(Some(project.to_str().context("Repository path must be UTF-8.")?))?;
    resolved.require_trust()?;
    resolved.values["branchPrefix"].value.as_str().map(str::to_owned).context("Invalid branch prefix.")
}

/// A resolved value and every layer that supplies its key, highest first
/// (`ConfigurationValue` in src/types/configuration.ts).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcedValue {
    #[serde(flatten)]
    pub resolved: ResolvedValue,
    pub layers: Vec<LayerValue>,
}
/// What the Settings window reads: a [`Resolution`] whose values carry their layers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredResolution {
    pub values: BTreeMap<String, SourcedValue>,
    pub registry: &'static [Key],
    pub warnings: Vec<String>,
    pub trust: Option<Trust>,
}

impl LayeredResolution {
    /// Environment values are redacted in every layer, as they are in `values`.
    fn new(resolved: Resolution, mut layers: Layers) -> Self {
        let values = resolved.values.into_iter().map(|(key, value)| {
            let mut own = layers.remove(&key).unwrap_or_default();
            own.sort_by_key(|entry| std::cmp::Reverse(entry.layer));
            own.dedup_by_key(|entry| entry.layer);
            if key.starts_with("environment.") {
                for entry in &mut own { entry.value = Value::Null; entry.redacted = true; }
            }
            // The first layer is the value's source, whatever supplied it.
            if own.first().map(|entry| entry.layer) != Some(value.source) {
                own.retain(|entry| entry.layer != value.source);
                own.insert(0, LayerValue { layer: value.source, value: value.value.clone(), redacted: value.redacted });
            }
            (key, SourcedValue { resolved: value, layers: own })
        }).collect();
        Self { values, registry: resolved.registry, warnings: resolved.warnings, trust: resolved.trust }
    }
}

/// [`view`] with each value's layers, for Settings source badges (PRO-140).
/// Private variables add their layer (user or repository) by name only.
pub fn layered_view(project: Option<&str>) -> Result<LayeredResolution> {
    let repository = project.map(|path| repository(Path::new(path))).transpose()?;
    let (files, mut layers) = Store::current()?.resolve_layers(repository.as_ref())?;
    // A missing index is reported by with_private_sources below.
    if let Ok(rows) = super::environment::list(project) {
        for row in rows {
            let row = serde_json::to_value(&row)?;
            let (Some(name), Some(scope)) = (row["name"].as_str(), row["scope"].as_str()) else { continue };
            let layer = if scope == "repository" { Layer::RepositoryLocal } else { Layer::User };
            let entries = layers.entry(format!("environment.{name}")).or_default();
            if !entries.iter().any(|entry| entry.layer == layer) { entries.push(LayerValue { layer, value: Value::Null, redacted: true }); }
        }
    }
    Ok(LayeredResolution::new(with_private_sources(project, files).redacted(), layers))
}

/// The JSON schema of `.terminalx/settings.json` and `.terminalx/settings.local.json`
/// (and of the managed policy, which takes the same keys), from [`REGISTRY`]
/// and the limits [`valid`] reads. The tests write it to
/// schemas/repository-settings.schema.json (see `settings::schema`).
#[cfg(test)]
pub fn repository_schema() -> Value {
    #[derive(Deserialize)]
    struct Reserved { names: Vec<String>, prefixes: Vec<String> }
    // The names environment::validate_name refuses, from the same file.
    let reserved: Reserved = serde_json::from_str(include_str!("environment_reserved.json")).expect("reserved environment names");
    let prefixes = reserved.prefixes.iter().map(|prefix| regex::escape(prefix)).collect::<Vec<_>>().join("|");
    let mut properties = Map::new();
    properties.insert("$schema".into(), json!({"type": "string", "description": "The JSON schema editors check this file against."}));
    for key in REGISTRY.iter().filter(|key| key.repository_configurable) {
        let schema = match key.key {
            "branchPrefix" => json!({
                "type": "string", "maxLength": BRANCH_PREFIX_MAX, "pattern": BRANCH_PREFIX_PATTERN,
                "description": "Prefix for new workspace branches and for which branches workspace cleanup recognizes, such as \"team/\". Slash-separated parts of ASCII letters, digits, hyphens and underscores. Empty disables prefix-based cleanup. A shared value needs the person's trust.",
            }),
            "environment" => json!({
                "type": "object", "maxProperties": ENVIRONMENT_MAX_VARIABLES,
                "propertyNames": {
                    "pattern": "^[A-Z_][A-Z0-9_]*$", "maxLength": 128,
                    "not": {"anyOf": [{"enum": reserved.names}, {"pattern": format!("^(?:{prefixes})")}]},
                },
                "additionalProperties": {"type": "string", "maxLength": ENVIRONMENT_MAX_VALUE, "pattern": "^[^\\u0000]*$"},
                "description": "Literal environment variables for sessions started in this repository; never expanded. Values are at most 64 KiB. Shared values need the person's trust.",
            }),
            "sparseCheckout" => json!({
                "type": "array", "maxItems": SPARSE_CHECKOUT_MAX_FOLDERS, "uniqueItems": true,
                "items": {"type": "string", "maxLength": SPARSE_CHECKOUT_MAX_PATH, "pattern": SPARSE_FOLDER_PATTERN},
                "description": "Folders new workspaces of this repository check out, relative to its root, such as \"packages/web\"; root files are always checked out. An empty list checks out root files only; absent checks out everything. Each folder is at most 1024 bytes.",
            SETUP_SCRIPT | ARCHIVE_SCRIPT => json!({
                "type": "string", "maxLength": SCRIPT_LIMIT, "pattern": "^[^\\u0000]*$",
                "description": if key.key == SETUP_SCRIPT {
                    "Shell script run by /bin/sh in each new worktree of this repository, after it is created. At most 64 KiB. A shared value needs the person's trust; a local or saved script replaces it."
                } else {
                    "Shell script run by /bin/sh in a worktree of this repository before it is removed. At most 64 KiB. A shared value needs the person's trust; a local or saved script replaces it."
                },
            }),
            ARCHIVE_TIMEOUT => json!({
                "type": "integer", "enum": ARCHIVE_TIMEOUT_CHOICES, "default": DEFAULT_ARCHIVE_TIMEOUT_MINUTES,
                "description": "Minutes the archive script may run before it is stopped.",
            }),
            other => panic!("repository key {other} has no schema"),
        };
        properties.insert(key.key.into(), schema);
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "TerminalX repository settings",
        "description": "<primary checkout>/.terminalx/settings.json (shared in Git) and .terminalx/settings.local.json (ignored). Precedence, highest first: managed policy, repository local, repository shared, user, defaults. Unknown keys are ignored.",
        "type": "object",
        "properties": properties,
        "additionalProperties": false,
    })
}

/// Whether Git tracks, ignores, or has never seen a repository file.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitState { Committed, Ignored, Untracked }

/// One layer of the settings a project resolves, for Settings files
/// (`SettingsFileLayer` in src/types/settingsSources.ts). Never carries values.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileLayer {
    pub layer: Layer,
    pub path: Option<String>,
    pub display_path: Option<String>,
    pub exists: bool,
    pub keys: usize,
    pub git: Option<GitState>,
    pub problem: Option<Problem>,
}

fn git_state(root: &Path, file: &str) -> Option<GitState> {
    if !git(root, &["ls-files", "--", file]).ok()?.is_empty() { return Some(GitState::Committed); }
    Some(if git(root, &["check-ignore", "--no-index", file]).is_ok() { GitState::Ignored } else { GitState::Untracked })
}

/// One file's layer, from what reading it returned. `malformed` is what an
/// unparseable file does to its values; a key it may not set is ignored,
/// except in managed policy, which refuses resolution instead.
fn file_layer(layer: Layer, path: &Path, read: Result<Option<Vec<u8>>>, malformed: Effect) -> FileLayer {
    let mut entry = FileLayer { layer, path: Some(path.to_string_lossy().into()), display_path: Some(display_path(path)), exists: false, keys: 0, git: None, problem: None };
    let problem = |key: Option<String>, line: Option<usize>, message: String, effect: Effect| Some(Problem { key, line, message, effect });
    let bytes = match read {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return entry,
        // An unsafe or unreadable file stops resolution for every layer. The
        // message is this module's own (never the file's content).
        Err(error) => {
            entry.exists = std::fs::symlink_metadata(path).is_ok();
            entry.problem = problem(None, None, error.to_string(), Effect::Blocked);
            return entry;
        }
    };
    entry.exists = true;
    let document = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(document)) => document,
        Ok(_) => { entry.problem = problem(None, Some(1), "expected a JSON object".into(), malformed); return entry; }
        Err(error) => { entry.problem = problem(None, Some(error.line()), parser_words(&error), malformed); return entry; }
    };
    entry.keys = document.keys().filter(|key| *key != "$schema").count();
    let lines = std::str::from_utf8(&bytes).ok().and_then(member_lines).unwrap_or_default();
    let line = |key: &str| lines.iter().find(|(name, _)| name == key).map(|(_, line)| *line);
    let mut refused: Vec<(Option<usize>, &String, &'static str)> = document.iter()
        .filter_map(|(key, value)| refusal(key, value, layer).map(|why| (line(key), key, why)))
        .collect();
    refused.sort_by_key(|(line, _, _)| line.unwrap_or(usize::MAX));
    if let Some((line, key, why)) = refused.first() {
        let key: String = key.chars().filter(|c| !c.is_control()).take(100).collect();
        let effect = if layer == Layer::Managed { Effect::Blocked } else { Effect::IgnoredKey };
        entry.problem = problem(Some(key), *line, (*why).into(), effect);
    }
    entry
}

impl Store {
    fn managed_path(&self) -> Option<PathBuf> {
        #[cfg(test)]
        if let Some(path) = &self.managed_fixture { return Some(path.clone()); }
        super::managed_configuration::path().map(Path::to_path_buf)
    }

    /// Every file a project's settings resolve from, highest layer first:
    /// managed policy, repository local, repository shared, user, defaults.
    pub fn files(&self, repository: Option<&Repository>) -> Vec<FileLayer> {
        let mut files = Vec::new();
        if let Some(path) = self.managed_path() {
            files.push(file_layer(Layer::Managed, &path, self.managed(), Effect::Blocked));
        }
        if let Some(repository) = repository {
            let directory = repository.root.join(".terminalx");
            let opened = Directory::open(&directory, false);
            for (layer, name, malformed) in [(Layer::RepositoryLocal, LOCAL, Effect::Blocked), (Layer::RepositoryShared, SHARED, Effect::FileIgnored)] {
                let read = match &opened { Ok(dir) => read(dir.as_ref(), name), Err(error) => Err(anyhow::anyhow!("{error}")) };
                let mut entry = file_layer(layer, &directory.join(name), read, malformed);
                entry.git = git_state(&repository.root, &format!(".terminalx/{name}"));
                // resolve() refuses a local file Git tracks or does not ignore.
                if layer == Layer::RepositoryLocal && entry.exists && entry.problem.is_none() && entry.git != Some(GitState::Ignored) {
                    let message = if entry.git == Some(GitState::Committed) { "is tracked by Git; local settings must not be committed" }
                        else { "isn’t ignored by Git; add /settings.local.json to .terminalx/.gitignore" };
                    entry.problem = Some(Problem { key: None, line: None, message: message.into(), effect: Effect::Blocked });
                }
                files.push(entry);
            }
        }
        let path = self.home.join(SHARED);
        let user = super::settings::file::status_of(&path);
        let mut keys: Vec<&str> = user.set_keys.iter().map(|key| key.split('.').next().unwrap_or(key)).collect();
        keys.dedup();
        files.push(FileLayer {
            layer: Layer::User, path: Some(path.to_string_lossy().into()), display_path: Some(user.display_path.clone()),
            exists: user.exists, keys: keys.len(), git: None, problem: user.problem.clone(),
        });
        files.push(FileLayer { layer: Layer::Defaults, path: None, display_path: None, exists: true, keys: super::settings::file::default_keys(), git: None, problem: None });
        files
    }
}

#[cfg(test)]
#[path = "configuration_tests.rs"]
mod tests;
