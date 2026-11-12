//! Local environment overrides. The index contains names and opaque revisions,
//! never Keychain values (nor hashes of values). Each revision is one Keychain
//! item. Values the user chose to store plainly (PRO-144: they do not look like
//! secrets, or the Keychain switch was off) live in the index's `plain` map.
//! A transaction switches the index only after the new item is safely stored.
//! No repository file is evaluated or trusted implicitly.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::keychain::{Keychain, SecretStore};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.terminalx.environment";
const USER: &str = "user";
pub const MAX_BYTES: usize = 1024 * 1024;
type Values = BTreeMap<String, String>;
type Index = BTreeMap<String, Scope>;

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct Scope {
    /// Names held in this revision's Keychain item.
    names: BTreeSet<String>,
    revision: String,
    /// Values kept outside the Keychain, by the user's choice when saving.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    plain: Values,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Stamp {
    repository: Option<String>,
    user: String,
    repo: String,
    #[serde(default)]
    unavailable: bool,
}

// Deliberately no Debug/Serialize: resolved values must never enter diagnostics.
pub struct Launch {
    pub values: Values,
    pub stamp: Stamp,
}

impl Launch {
    pub(crate) fn require_available(&self) -> Result<()> {
        ensure!(!self.stamp.unavailable, "Environment overrides are unavailable. Open TerminalX Settings → Environment, restore Keychain access, then retry.");
        Ok(())
    }

    pub fn inject(&self, command: &mut portable_pty::CommandBuilder) {
        for (name, value) in &self.values {
            command.env(name, value);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    name: String,
    /// "user" or "repository" (this store), or the repository file layer the
    /// name comes from: "repositoryShared", "repositoryLocal" or "managed".
    scope: &'static str,
    overridden: bool,
    /// Whether the value is in the Keychain. File values are never sent here.
    secret: bool,
    /// Only a value the user chose to store plainly.
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    /// For a Personal variable: the Git common directories of the
    /// repositories whose own variable of this name overrides it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    overridden_in: Vec<String>,
}

#[derive(Deserialize)]
pub struct Input {
    pub name: String,
    pub value: String,
    /// Keep the value in the Keychain. Older callers never sent it: Keychain.
    #[serde(default = "keychain_by_default")]
    pub secret: bool,
}

fn keychain_by_default() -> bool {
    true
}

/// Both kinds of value of one scope. A name is in at most one of them.
#[derive(Default)]
struct Entries {
    secret: Values,
    plain: Values,
}

impl Entries {
    fn remove(&mut self, name: &str) -> bool {
        self.secret.remove(name).is_some() | self.plain.remove(name).is_some()
    }
    fn contains(&self, name: &str) -> bool {
        self.secret.contains_key(name) || self.plain.contains_key(name)
    }
}

pub fn validate_name(name: &str) -> Result<()> {
    let mut bytes = name.bytes();
    ensure!(
        name.len() <= 128
            && matches!(bytes.next(), Some(b'A'..=b'Z' | b'_'))
            && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
        "Use a name matching [A-Z_][A-Z0-9_]* (at most 128 characters)."
    );
    #[derive(Deserialize)]
    struct Reserved {
        names: Vec<String>,
        prefixes: Vec<String>,
    }
    static RESERVED: std::sync::OnceLock<Reserved> = std::sync::OnceLock::new();
    let reserved = RESERVED.get_or_init(|| {
        serde_json::from_str(include_str!("environment_reserved.json"))
            .expect("valid reserved environment names")
    });
    ensure!(
        !reserved.names.iter().any(|reserved| reserved == name)
            && !reserved
                .prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix)),
        "This name is reserved by TerminalX."
    );
    Ok(())
}

fn validate_values(values: &Values) -> Result<()> {
    ensure!(
        values.len() <= 256,
        "A scope can hold at most 256 variables."
    );
    ensure!(
        values.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() <= MAX_BYTES,
        "Environment values are too large."
    );
    for (name, value) in values {
        validate_name(name)?;
        ensure!(
            !value.contains('\0') && value.len() <= 64 * 1024,
            "Values must contain no NUL and be at most 64 KiB."
        );
    }
    Ok(())
}

/// All worktrees and subdirectories of a repository share its Git common dir.
/// Git's inherited discovery overrides must not redirect this lookup elsewhere.
fn repository(cwd: &Path) -> Option<String> {
    let git = crate::binpath::resolve("git").unwrap_or_else(|| PathBuf::from("git"));
    let output = std::process::Command::new(git)
        .current_dir(cwd)
        .env("PATH", crate::binpath::login_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    Some(format!(
        "repository:{}",
        path.canonicalize().ok()?.to_str()?
    ))
}

fn scope_key(project: Option<&str>) -> Result<String> {
    match project {
        None => Ok(USER.into()),
        Some(path) => repository(Path::new(path)).context("Choose a local Git repository."),
    }
}

struct Store<'a> {
    root: PathBuf,
    secrets: &'a dyn SecretStore,
}

impl Store<'_> {
    fn index(&self) -> Result<Index> {
        // Do not propagate parser errors: a hand-edited file might contain a value.
        super::read_json(&self.root.join("environment.json"))
            .map(|v| v.unwrap_or_default())
            .map_err(|_| anyhow::anyhow!("Could not read the environment index."))
    }

    fn transaction<T>(&self, run: impl FnOnce() -> Result<T>) -> Result<T> {
        super::transaction::run(
            &self.root.join("environment.lock"),
            Duration::from_secs(10),
            run,
        )
    }

    fn values(&self, scope: Option<&Scope>) -> Result<Values> {
        let Some(scope) = scope else {
            return Ok(Values::new());
        };
        if scope.names.is_empty() {
            return Ok(Values::new());
        }
        let bytes = self.secrets.get(SERVICE, &scope.revision)
            .map_err(|_| anyhow::anyhow!("Could not read environment values from Keychain."))?
            .context("Environment values are missing from Keychain. Restore the Keychain item to use these overrides.")?;
        let values: Values = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("Invalid environment values in Keychain."))?;
        ensure!(
            values.keys().cloned().collect::<BTreeSet<_>>() == scope.names,
            "Environment index and Keychain disagree."
        );
        validate_values(&values)?;
        Ok(values)
    }

    #[cfg(test)]
    fn change(&self, key: &str, update: impl Fn(&mut Values) -> Result<()>) -> Result<()> {
        self.change_entries(key, |entries| update(&mut entries.secret))
    }

    fn change_entries(&self, key: &str, update: impl Fn(&mut Entries) -> Result<()>) -> Result<()> {
        // Keychain may wait on OS consent. All reads, writes and deletes happen
        // outside the file lock; only the compare-and-swap of metadata is locked.
        for _ in 0..16 {
            let old = self.index()?.get(key).cloned();
            let secret = match self.values(old.as_ref()) {
                Ok(values) => values,
                Err(_) if self.index()?.get(key) != old.as_ref() => continue,
                Err(error) => return Err(error),
            };
            let mut entries = Entries { secret, plain: old.as_ref().map(|scope| scope.plain.clone()).unwrap_or_default() };
            update(&mut entries)?;
            let Entries { secret: values, plain } = entries;
            ensure!(
                !values.keys().any(|name| plain.contains_key(name)),
                "A variable with this name already exists in this scope."
            );
            validate_values(&values.iter().chain(&plain).map(|(k, v)| (k.clone(), v.clone())).collect())?;
            let scope = Scope {
                names: values.keys().cloned().collect(),
                revision: uuid::Uuid::new_v4().to_string(),
                plain,
            };
            if !values.is_empty() {
                self.secrets
                    .set(SERVICE, &scope.revision, &serde_json::to_vec(&values)?)
                    .map_err(|_| {
                        anyhow::anyhow!(
                            "Could not save environment values to Keychain. Nothing changed."
                        )
                    })?;
            }
            let committed = self.transaction(|| {
                let mut index = self.index()?;
                if index.get(key) != old.as_ref() {
                    return Ok(false);
                }
                index.insert(key.into(), scope.clone());
                super::write_json(&self.root.join("environment.json"), &index).map_err(|_| {
                    anyhow::anyhow!("Could not save the environment index. Nothing changed.")
                })?;
                Ok(true)
            });
            match committed {
                Ok(true) => {
                    if let Some(old) = old {
                        let _ = self.secrets.delete(SERVICE, &old.revision);
                    }
                    return Ok(());
                }
                other => {
                    let _ = self.secrets.delete(SERVICE, &scope.revision);
                    other?;
                }
            }
        }
        bail!("Environment changed concurrently. Try saving again.")
    }

    fn save(&self, key: &str, inputs: Vec<Input>, previous: Option<&str>) -> Result<()> {
        ensure!(!inputs.is_empty(), "Add at least one variable.");
        ensure!(
            previous.is_none() || inputs.len() == 1,
            "Edit one variable at a time."
        );
        self.change_entries(key, |entries| {
            if let Some(previous) = previous {
                ensure!(entries.remove(previous), "Variable no longer exists.");
            }
            for Input { name, value, secret } in &inputs {
                validate_name(name)?;
                ensure!(
                    !entries.contains(name),
                    "A variable with this name already exists in this scope."
                );
                let values = if *secret { &mut entries.secret } else { &mut entries.plain };
                values.insert(name.clone(), value.clone());
            }
            Ok(())
        })
    }

    #[cfg(test)]
    fn resolve(&self, repository: Option<String>) -> Result<Launch> {
        let index = self.index()?;
        let mut cache = Cache::default();
        for (key, scope) in &index {
            if key == USER || repository.as_ref() == Some(key) {
                cache.install(key, self.snapshot(key, &scope.revision)?, &index)?;
            }
        }
        Ok(cache.resolve(Some(&index), repository))
    }

    fn snapshot(&self, key: &str, revision: &str) -> Result<Snapshot> {
        let index = self.index()?;
        let scope = index
            .get(key)
            .filter(|scope| scope.revision == revision)
            .context("Environment changed. Try again.")?;
        let values = self.values(Some(scope))?;
        ensure!(
            self.index()?.get(key) == Some(scope),
            "Environment changed. Try again."
        );
        Ok(Snapshot {
            revision: revision.into(),
            values,
        })
    }
}

fn store() -> Result<Store<'static>> {
    Ok(Store {
        root: super::root()?,
        secrets: &Keychain,
    })
}
fn stamp(index: &Index, repository: Option<String>) -> Stamp {
    Stamp {
        user: index
            .get(USER)
            .map(|s| s.revision.clone())
            .unwrap_or_default(),
        repo: repository
            .as_ref()
            .and_then(|key| index.get(key))
            .map(|s| s.revision.clone())
            .unwrap_or_default(),
        repository,
        unavailable: false,
    }
}

#[derive(Default, Serialize, Deserialize)]
pub struct Status {
    pub changed: bool,
    pub unavailable: bool,
}

impl Stamp {
    pub fn status(&self) -> Result<Status> {
        Ok(Status {
            changed: self.unavailable || self.changed()?,
            unavailable: self.unavailable,
        })
    }

    /// A pane handed over by a runtime predating environment overrides never
    /// received any. Keep its repository identity so later edits still warn.
    pub fn unconfigured(cwd: &str) -> Self {
        Self {
            repository: repository(Path::new(cwd)),
            ..Self::default()
        }
    }

    pub fn changed(&self) -> Result<bool> {
        Ok(*self != stamp(&store()?.index()?, self.repository.clone()))
    }
}

/// Only sent in a response to the registered desktop's private service. Never
/// a control request, log record or handover field.
#[derive(Serialize, Deserialize)]
pub(crate) struct Snapshot {
    revision: String,
    values: Values,
}

#[derive(Default)]
struct Cache {
    scopes: BTreeMap<String, Snapshot>,
}

impl Cache {
    fn install(&mut self, key: &str, snapshot: Snapshot, index: &Index) -> Result<()> {
        let scope = index.get(key).context("Unknown environment scope.")?;
        ensure!(snapshot.revision == scope.revision, "Environment changed.");
        ensure!(
            snapshot.values.keys().cloned().collect::<BTreeSet<_>>() == scope.names,
            "Invalid environment snapshot."
        );
        validate_values(&snapshot.values)?;
        self.scopes.insert(key.into(), snapshot);
        Ok(())
    }

    fn resolve(&self, index: Option<&Index>, repository: Option<String>) -> Launch {
        let Some(index) = index else {
            return Launch {
                values: Values::new(),
                stamp: Stamp {
                    repository,
                    unavailable: true,
                    ..Default::default()
                },
            };
        };
        let mut stamp = stamp(index, repository);
        let mut values = Values::new();
        for key in std::iter::once(USER).chain(stamp.repository.as_deref()) {
            let Some(scope) = index.get(key) else {
                continue;
            };
            values.extend(scope.plain.clone());
            if scope.names.is_empty() {
                continue;
            }
            match self
                .scopes
                .get(key)
                .filter(|cached| cached.revision == scope.revision)
            {
                Some(cached) => values.extend(cached.values.clone()),
                None => {
                    stamp.unavailable = true;
                    break;
                }
            }
        }
        // No partial credential/endpoint combinations when one scope is missing.
        if stamp.unavailable {
            values.clear();
        }
        Launch { values, stamp }
    }
}

fn cache() -> &'static std::sync::Mutex<Cache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Cache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

#[cfg(feature = "desktop")]
pub(crate) fn desktop_snapshot(key: &str, revision: &str) -> Result<Snapshot> {
    use std::sync::atomic::{AtomicBool, Ordering};
    // A Keychain prompt may outlive the runtime's request timeout. Do not pile
    // up more blocked reads behind it. No mutex or file lock is held here.
    static READING: AtomicBool = AtomicBool::new(false);
    ensure!(
        !READING.swap(true, Ordering::AcqRel),
        "Environment read is already in progress."
    );
    struct Reading;
    impl Drop for Reading {
        fn drop(&mut self) {
            READING.store(false, Ordering::Release);
        }
    }
    let _reading = Reading;
    store()?.snapshot(key, revision)
}

struct Retry {
    after: std::time::Instant,
    delay: Duration,
}

impl Retry {
    fn failed(previous: Option<&Self>, now: std::time::Instant) -> Self {
        let delay = previous.map_or(Duration::from_secs(5), |retry| {
            (retry.delay * 2).min(Duration::from_secs(300))
        });
        Self { after: now + delay, delay }
    }
}

fn refresh_cache(
    cache: &std::sync::Mutex<Cache>,
    store: &Store<'_>,
    attempts: &mut BTreeMap<String, Retry>,
    fetch: impl Fn(&str, &str) -> Result<Snapshot>,
) -> Result<()> {
    let index = store.index()?;
    let pending: Vec<_> = {
        let mut cache = cache.lock().unwrap();
        cache.scopes.retain(|key, snapshot| {
            index
                .get(key)
                .is_some_and(|scope| scope.revision == snapshot.revision)
        });
        index
            .iter()
            .filter(|(key, scope)| !scope.names.is_empty() && !cache.scopes.contains_key(*key))
            .map(|(key, scope)| (key.clone(), scope.revision.clone()))
            .collect()
    };
    attempts.retain(|revision, _| index.values().any(|scope| &scope.revision == revision));
    for (key, revision) in pending {
        if attempts
            .get(&revision)
            .is_some_and(|retry| std::time::Instant::now() < retry.after)
        {
            continue;
        }
        // This may wait for desktop consent. No runtime/cache/store lock is held.
        let installed = if let Ok(snapshot) = fetch(&key, &revision) {
            let current = store.index()?;
            cache.lock().unwrap().install(&key, snapshot, &current).is_ok()
        } else {
            false
        };
        if installed {
            attempts.remove(&revision);
        } else {
            let retry = Retry::failed(attempts.get(&revision), std::time::Instant::now());
            attempts.insert(revision, retry);
        }
    }
    Ok(())
}

/// Prefetch on a dedicated runtime worker. Only the desktop accesses Keychain;
/// launches and metadata reads neither wait for this worker nor take its locks.
/// The cache is intentionally absent from runtime handover; reattachment refills it.
#[cfg(unix)]
pub(crate) fn start(lifetime: &std::sync::Arc<crate::local_runtime::Lifetime>) -> Result<()> {
    let lifetime = std::sync::Arc::downgrade(lifetime);
    std::thread::Builder::new()
        .name("environment-cache".into())
        .spawn(move || {
            let mut attempts = BTreeMap::new();
            while let Some(lifetime) = lifetime.upgrade() {
                if lifetime.is_stopping() {
                    break;
                }
                if lifetime.window.available() {
                    if let Ok(store) = store() {
                        let _ = refresh_cache(cache(), &store, &mut attempts, |key, revision| {
                            lifetime.window.environment_snapshot(key, revision)
                        });
                    }
                }
                drop(lifetime);
                std::thread::sleep(Duration::from_millis(250));
            }
        })?;
    Ok(())
}

// Runtime launches use only the in-memory cache, never the Keychain. A missing
// or failed read deliberately degrades to no overrides and a per-tab notice.
#[cfg(not(test))]
pub fn launch(cwd: &str) -> Result<Launch> {
    let repo = if cfg!(target_os = "macos") {
        repository(Path::new(cwd))
    } else {
        None
    };
    let index = store().and_then(|store| store.index());
    let cache = cache().lock().unwrap();
    let mut launch = cache.resolve(index.as_ref().ok(), repo.clone());
    drop(cache);
    let local_names: Option<BTreeSet<String>> = repo.as_ref().and_then(|key| index.as_ref().ok()?.get(key)).map(|scope| scope.names.iter().chain(scope.plain.keys()).cloned().collect());
    let repository = super::configuration::repository(Path::new(cwd)).ok();
    let resolution = super::configuration::Store::current()?.resolve(repository.as_ref())?;
    apply_configuration(&mut launch, resolution, local_names.as_ref())?;
    Ok(launch)
}

// PTY fixtures must never read the developer's saved names or depend on the
// process-wide TempHome used concurrently by unrelated store tests. Injection
// tests install a resolved in-memory fixture for exactly one launch.
#[cfg(test)]
thread_local! {
    static TEST_LAUNCH: std::cell::RefCell<Option<Launch>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub fn launch(_cwd: &str) -> Result<Launch> {
    Ok(TEST_LAUNCH
        .with(|slot| slot.borrow_mut().take())
        .unwrap_or_else(|| Launch {
            values: Values::new(),
            stamp: Stamp::default(),
        }))
}


/// Keychain repository entries are a legacy local layer: they override shared
/// file values, while explicit local-file entries and managed policy win.
fn apply_configuration(launch: &mut Launch, mut resolution: super::configuration::Resolution, local_names: Option<&BTreeSet<String>>) -> Result<()> {
    resolution.values.retain(|key, resolved| {
        !(resolved.source == super::configuration::Layer::RepositoryShared
            && key.strip_prefix("environment.").is_some_and(|name| local_names.is_some_and(|names| names.contains(name))))
    });
    resolution.refresh_trust();
    resolution.require_trust()?;
    // Preserve the existing all-or-nothing behavior for unavailable Keychain values.
    if launch.stamp.unavailable {
        ensure!(!resolution.values.keys().any(|key| key.starts_with("environment.")), "Environment overrides are unavailable; no partial layered environment was applied.");
        return Ok(());
    }
    for (key, resolved) in resolution.values {
        let Some(name) = key.strip_prefix("environment.") else { continue; };
        if let Some(value) = resolved.value.as_str() { launch.values.insert(name.into(), value.into()); }
    }
    Ok(())
}

fn wait_until_ready(mut ready: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if ready() { return true; }
        let now = std::time::Instant::now();
        if now >= deadline { return false; }
        std::thread::sleep((deadline - now).min(Duration::from_millis(25)));
    }
}

/// Wait only for the in-memory cache, outside launch/tab/store locks. The
/// desktop worker alone performs Keychain reads. A save can wait for its new
/// revision before telling the user that new launches are ready.
pub fn wait_ready(project: Option<&str>) -> bool {
    let repo = project.and_then(|cwd| repository(Path::new(cwd)));
    wait_until_ready(|| {
        let index = store().and_then(|store| store.index());
        !cache().lock().unwrap().resolve(index.as_ref().ok(), repo.clone()).stamp.unavailable
    }, Duration::from_secs(2))
}

/// Unattended work must report a missing configuration in its run result,
/// instead of silently sending a prompt with different credentials/endpoints.
pub fn prepare_unattended(cwd: &str, running: Option<Status>) -> Result<()> {
    if let Some(status) = running {
        ensure!(!status.unavailable, "This agent started without environment overrides. Restart the agent after restoring Keychain access, then retry this run. No prompt was sent.");
        return Ok(());
    }
    check_unattended(prepare_launch(cwd))
}

#[cfg(not(test))]
fn prepare_launch(cwd: &str) -> bool { wait_ready(Some(cwd)) }

// Process-level fixtures never consult the developer's saved environment.
// The readiness wait and failure policy are exercised with isolated stores.
#[cfg(test)]
fn prepare_launch(_cwd: &str) -> bool { true }

fn check_unattended(ready: bool) -> Result<()> {
    ensure!(ready, "Environment overrides are unavailable. Open TerminalX Settings → Environment, unlock Keychain if requested, then retry this run. No prompt was sent.");
    Ok(())
}

/// This store's rows for one scope: inherited Personal names first (in a
/// repository), then the scope's own. Values only for plainly stored ones.
fn rows(index: &Index, key: &str) -> Vec<Row> {
    let row = |name: &String, scope: &'static str, plain: Option<&String>| Row {
        name: name.clone(),
        scope,
        overridden: false,
        secret: plain.is_none(),
        value: plain.cloned(),
        overridden_in: Vec::new(),
    };
    let own = index.get(key);
    let has = |scope: &Scope, name: &String| scope.names.contains(name) || scope.plain.contains_key(name);
    let mut rows = Vec::new();
    let add = |scope: &Scope, label: &'static str| {
        let mut own_rows: Vec<Row> = scope.names.iter().map(|name| row(name, label, None))
            .chain(scope.plain.iter().map(|(name, value)| row(name, label, Some(value)))).collect();
        own_rows.sort_by(|a, b| a.name.cmp(&b.name));
        own_rows
    };
    if key != USER {
        if let Some(user) = index.get(USER) {
            rows.extend(add(user, "user").into_iter().map(|mut row| {
                row.overridden = own.is_some_and(|own| has(own, &row.name));
                row
            }));
        }
    }
    if let Some(scope) = own {
        rows.extend(add(scope, if key == USER { "user" } else { "repository" }).into_iter().map(|mut row| {
            if key == USER {
                row.overridden_in = index.iter()
                    .filter(|(other, scope)| other.as_str() != USER && has(scope, &row.name))
                    .filter_map(|(other, _)| other.strip_prefix("repository:").map(String::from))
                    .collect();
            }
            row
        }));
    }
    rows
}

/// Merge the repository files' (and managed policy's) environment names, as
/// Layered configuration lists them, with the same precedence as a launch:
/// this store's repository variables override the shared file only; the local
/// file and managed policy override everything here. File values stay out.
fn merge_file_rows(rows: &mut Vec<Row>, resolution: &super::configuration::Resolution) {
    use super::configuration::Layer;
    for (key, resolved) in &resolution.values {
        let Some(name) = key.strip_prefix("environment.") else { continue };
        let scope = match resolved.source {
            Layer::RepositoryShared => "repositoryShared",
            Layer::RepositoryLocal => "repositoryLocal",
            Layer::Managed => "managed",
            _ => continue,
        };
        let local = rows.iter().any(|row| row.scope == "repository" && row.name == name);
        for row in rows.iter_mut().filter(|row| row.name == name) {
            if row.scope == "user" || scope != "repositoryShared" {
                row.overridden = true;
            }
        }
        rows.push(Row {
            name: name.into(),
            scope,
            overridden: scope == "repositoryShared" && local,
            secret: false,
            value: None,
            overridden_in: Vec::new(),
        });
    }
}

fn private_rows(project: Option<&str>) -> Result<Vec<Row>> {
    let key = scope_key(project)?;
    Ok(rows(&store()?.index()?, &key))
}

pub fn list(project: Option<&str>) -> Result<Vec<Row>> {
    let mut rows = private_rows(project)?;
    // Best effort: an unreadable repository file must not hide private rows;
    // Layered configuration reports why it is unreadable.
    if let Ok(resolution) = super::configuration::resolve(project) {
        merge_file_rows(&mut rows, &resolution);
    }
    Ok(rows)
}

pub(super) fn configuration_sources(project: Option<&str>, values: &mut BTreeMap<String, super::configuration::ResolvedValue>) -> Result<()> {
    use super::configuration::{Layer, ResolvedValue};
    for row in private_rows(project)? {
        let key = format!("environment.{}", row.name);
        let local = row.scope == "repository";
        if values.get(&key).is_none_or(|value| local && matches!(value.source, Layer::User | Layer::RepositoryShared)) {
            values.insert(key, ResolvedValue { value: serde_json::Value::Null, source: if local { Layer::RepositoryLocal } else { Layer::User }, locked: false, redacted: true });
        }
    }
    Ok(())
}

pub fn reveal(project: Option<&str>, name: &str) -> Result<String> {
    validate_name(name)?;
    let key = scope_key(project)?;
    let store = store()?;
    let index = store.index()?;
    let scope = index.get(&key).context("Variable no longer exists.")?;
    if let Some(value) = scope.plain.get(name) {
        return Ok(value.clone());
    }
    store
        .snapshot(&key, &scope.revision)?
        .values
        .remove(name)
        .context("Variable no longer exists.")
}


fn refuse_managed_names<'a>(project: Option<&str>, names: impl Iterator<Item = &'a str>) -> Result<()> {
    let resolved = super::configuration::resolve(project)?;
    for name in names {
        ensure!(!resolved.values.get(&format!("environment.{name}")).is_some_and(|value| value.locked), "This variable is locked by managed configuration.");
    }
    Ok(())
}

pub fn save(project: Option<&str>, inputs: Vec<Input>, previous: Option<&str>) -> Result<()> {
    refuse_managed_names(project, inputs.iter().map(|input| input.name.as_str()).chain(previous))?;
    store()?.save(&scope_key(project)?, inputs, previous)
}

pub fn delete(project: Option<&str>, name: &str) -> Result<()> {
    refuse_managed_names(project, std::iter::once(name))?;
    validate_name(name)?;
    store()?.change_entries(&scope_key(project)?, |entries| {
        ensure!(entries.remove(name), "Variable no longer exists.");
        Ok(())
    })
}

pub fn read_env_file(project: &str, path: &str) -> Result<String> {
    scope_key(Some(project))?;
    let root = Path::new(project)
        .canonicalize()
        .context("Choose a local repository.")?;
    let path = Path::new(path)
        .canonicalize()
        .context("Choose an existing .env file.")?;
    ensure!(
        path.starts_with(&root)
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == ".env" || name.starts_with(".env.")),
        "Choose a .env or .env.* file inside this repository."
    );
    use std::io::Read;
    let file = crate::workspace_file::open(&root, &path)
        .map_err(|_| anyhow::anyhow!("Could not open the .env file."))?;
    ensure!(file.metadata()?.is_file(), "Choose a regular .env file.");
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Could not read the .env file."))?;
    ensure!(
        bytes.len() <= MAX_BYTES,
        "The .env file must be at most 1 MiB."
    );
    String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("The .env file must be UTF-8 text."))
}

#[cfg(test)]
#[path = "environment_tests.rs"]
mod storage_tests;

#[cfg(test)]
mod tests {
    #[test]
    fn shared_environment_cannot_reach_a_launch_until_trusted_and_local_credentials_win() {
        use super::super::configuration::{Layer, ResolvedValue, Resolution, Trust, REGISTRY};
        let resolution = |required| Resolution {
            values: [("environment.API_URL".into(), ResolvedValue { value: serde_json::json!("$(echo literal)"), source: Layer::RepositoryShared, locked: false, redacted: false })].into(),
            registry: REGISTRY, warnings: Vec::new(), trust: Some(Trust { hash: "hash".into(), required, keys: vec!["environment.API_URL".into()] }),
        };
        let mut launch = Launch { values: [("API_URL".into(), "private".into())].into(), stamp: Stamp::default() };
        assert!(apply_configuration(&mut launch, resolution(true), None).is_err());
        assert_eq!(launch.values["API_URL"], "private", "declining applies no shared value");
        let names = ["API_URL".into()].into();
        apply_configuration(&mut launch, resolution(true), Some(&names)).unwrap();
        assert_eq!(launch.values["API_URL"], "private");
        apply_configuration(&mut launch, resolution(false), None).unwrap();
        assert_eq!(launch.values["API_URL"], "$(echo literal)");
        launch.stamp.unavailable = true;
        assert!(apply_configuration(&mut launch, resolution(false), None).is_err());
    }

    use super::*;
    use crate::keychain::testing::MemorySecrets;

    fn add(store: &Store<'_>, scope: &str, name: &str, value: &str) {
        store
            .change(scope, |values| {
                values.insert(name.into(), value.into());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn readiness_waits_for_a_fill_and_unattended_failure_is_actionable() {
        let mut checks = 0;
        assert!(wait_until_ready(|| { checks += 1; checks == 2 }, Duration::from_secs(1)));
        assert!(!wait_until_ready(|| false, Duration::ZERO));
        check_unattended(true).unwrap();
        let error = check_unattended(false).unwrap_err().to_string();
        assert!(error.contains("Environment overrides are unavailable"));
        assert!(error.contains("No prompt was sent"));
    }

    #[test]
    fn a_running_agent_keeps_its_environment_but_an_unconfigured_launch_cannot_run_unattended() {
        // Even after edits or a runtime restart, this process keeps the values
        // with which it launched; no cache fill is needed for a follow-up.
        prepare_unattended("/unused", Some(Status { changed: true, unavailable: false })).unwrap();
        let error = prepare_unattended("/unused", Some(Status { changed: true, unavailable: true })).unwrap_err().to_string();
        assert!(error.contains("Restart the agent"));
        assert!(error.contains("No prompt was sent"));
    }

    #[test]
    fn failed_reads_back_off_but_new_revisions_retry_immediately() {
        let root = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store { root: root.path().into(), secrets: &secrets };
        add(&store, USER, "KEY", "secret");
        let cache = std::sync::Mutex::new(Cache::default());
        let mut attempts = BTreeMap::new();
        let calls = std::cell::Cell::new(0);
        let denied = |_: &str, _: &str| -> Result<Snapshot> { calls.set(calls.get() + 1); bail!("denied") };
        refresh_cache(&cache, &store, &mut attempts, denied).unwrap();
        refresh_cache(&cache, &store, &mut attempts, denied).unwrap();
        assert_eq!(calls.get(), 1);
        for seconds in [10, 20, 40, 80, 160, 300, 300] {
            attempts.values_mut().next().unwrap().after = std::time::Instant::now();
            refresh_cache(&cache, &store, &mut attempts, denied).unwrap();
            assert_eq!(attempts.values().next().unwrap().delay, Duration::from_secs(seconds));
        }
        let before = calls.get();
        add(&store, USER, "OTHER", "new-secret");
        refresh_cache(&cache, &store, &mut attempts, denied).unwrap();
        assert_eq!(calls.get(), before + 1);
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts.values().next().unwrap().delay, Duration::from_secs(5));
        attempts.values_mut().next().unwrap().after = std::time::Instant::now();
        refresh_cache(&cache, &store, &mut attempts, |key, revision| store.snapshot(key, revision)).unwrap();
        assert!(attempts.is_empty());
        assert!(!cache.lock().unwrap().resolve(Some(&store.index().unwrap()), None).stamp.unavailable);
    }

    #[test]
    fn repository_overrides_user_without_leaking_to_other_repositories() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "SHARED", "user-secret");
        add(&store, USER, "USER_ONLY", "all");
        let before = store.resolve(Some("repo-a".into())).unwrap();
        add(&store, "repo-a", "SHARED", "repository-secret");
        add(&store, "repo-a", "REPO_ONLY", "private");
        let a = store.resolve(Some("repo-a".into())).unwrap();
        let b = store.resolve(Some("repo-b".into())).unwrap();
        assert_eq!(a.values["SHARED"], "repository-secret");
        assert_eq!(a.values["USER_ONLY"], "all");
        assert_eq!(b.values["SHARED"], "user-secret");
        assert!(!b.values.contains_key("REPO_ONLY"));
        assert_eq!(store.resolve(None).unwrap().values, b.values);
        assert!(before.stamp != a.stamp);
        let index = std::fs::read_to_string(dir.path().join("environment.json")).unwrap();
        for secret in ["user-secret", "repository-secret", "private"] {
            assert!(!index.contains(secret));
        }
        assert!(index.contains("SHARED"));
        store
            .change("repo-a", |values| {
                values.remove("SHARED");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.resolve(Some("repo-a".into())).unwrap().values["SHARED"],
            "user-secret"
        );
        assert!(b.stamp == store.resolve(Some("repo-b".into())).unwrap().stamp);
    }

    #[test]
    fn keychain_operations_never_hold_the_environment_transaction_lock() {
        let root = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let path = root.path().join("environment.lock");
        secrets.on_call(move || {
            // A child forked by another test can inherit a released lock until
            // it execs. Allow that brief overlap, as transaction's unwind test
            // does; a nested transaction still fails immediately.
            super::super::transaction::run(&path, Duration::from_secs(10), || Ok(())).unwrap();
        });
        let store = Store {
            root: root.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "first");
        let revision = store.index().unwrap()[USER].revision.clone();
        store.snapshot(USER, &revision).unwrap();
        store
            .change(USER, |values| {
                values.insert("KEY".into(), "second".into());
                Ok(())
            })
            .unwrap();
    }

    struct ReadFailure(MemorySecrets);
    impl SecretStore for ReadFailure {
        fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>> {
            bail!("denied private-value")
        }
        fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<()> {
            self.0.set(service, account, secret)
        }
        fn delete(&self, service: &str, account: &str) -> Result<()> {
            self.0.delete(service, account)
        }
    }

    #[test]
    fn failed_read_at_launch_omits_all_overrides_and_marks_the_tab_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: root.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "user-secret");
        add(&store, "repo", "KEY", "repo-secret");
        let index = store.index().unwrap();
        let cache = std::sync::Mutex::new(Cache::default());
        cache
            .lock()
            .unwrap()
            .install(
                "repo",
                store.snapshot("repo", &index["repo"].revision).unwrap(),
                &index,
            )
            .unwrap();
        let failed = ReadFailure(secrets.clone());
        let desktop = Store {
            root: root.path().into(),
            secrets: &failed,
        };
        refresh_cache(&cache, &store, &mut BTreeMap::new(), |key, revision| {
            desktop.snapshot(key, revision)
        })
        .unwrap();
        let launch = cache
            .lock()
            .unwrap()
            .resolve(Some(&index), Some("repo".into()));
        assert!(
            launch.values.is_empty(),
            "a missing user scope must not leave a partial configuration"
        );
        assert!(launch.stamp.unavailable);
        assert!(!serde_json::to_string(&launch.stamp)
            .unwrap()
            .contains("secret"));
        // Unlocking the desktop's Keychain restores future launches, not old tabs.
        refresh_cache(&cache, &store, &mut BTreeMap::new(), |key, revision| {
            store.snapshot(key, revision)
        })
        .unwrap();
        let recovered = cache
            .lock()
            .unwrap()
            .resolve(Some(&index), Some("repo".into()));
        assert!(!recovered.stamp.unavailable);
        assert_eq!(recovered.values["KEY"], "repo-secret");
        assert!(launch.stamp.unavailable);
        #[cfg(unix)]
        {
            TEST_LAUNCH.with(|slot| *slot.borrow_mut() = Some(launch));
            let terminals = crate::pty::Terminals::new();
            terminals
                .spawn(
                    std::sync::Arc::new(crate::sink::BroadcastSink::new(64)),
                    "session:failed-read",
                    crate::pty::PaneSpec {
                        cwd: root.path().to_str().unwrap(),
                        cols: 80,
                        rows: 24,
                        command: Some("/usr/bin/printf 'launched-without-overrides'"),
                        env: &[],
                    },
                )
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            while !String::from_utf8_lossy(
                &terminals
                    .read_output("session:failed-read")
                    .unwrap_or_default(),
            )
            .contains("launched-without-overrides")
            {
                assert!(
                    std::time::Instant::now() < deadline,
                    "failed Keychain read must not prevent a PTY launch"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            terminals.kill_all();
        }
        // Revisions fence a cache retained across a desktop disconnect.
        add(&store, USER, "NEW_KEY", "new-secret");
        assert!(
            cache
                .lock()
                .unwrap()
                .resolve(Some(&store.index().unwrap()), Some("repo".into()))
                .stamp
                .unavailable
        );
    }

    #[test]
    fn a_blocked_desktop_read_does_not_hold_launch_cache_or_store_locks() {
        let root = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: root.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "secret");
        let cache = std::sync::Mutex::new(Cache::default());
        let (entered, waiting) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let resume = std::sync::Mutex::new(resume);
        secrets.on_call(move || {
            entered.send(()).unwrap();
            resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
        });
        std::thread::scope(|threads| {
            let refreshing = threads.spawn(|| {
                refresh_cache(&cache, &store, &mut BTreeMap::new(), |key, revision| {
                    store.snapshot(key, revision)
                })
            });
            waiting.recv_timeout(Duration::from_secs(10)).unwrap();
            // This is the complete cache operation performed with a tab mutex
            // held at launch. It completes even while Keychain is still blocked.
            let launched = cache
                .try_lock()
                .expect("launch does not wait for Keychain")
                .resolve(Some(&store.index().unwrap()), None);
            assert!(launched.stamp.unavailable);
            store.transaction(|| Ok(())).unwrap();
            release.send(()).unwrap();
            refreshing.join().unwrap().unwrap();
        });
        assert!(
            !cache
                .lock()
                .unwrap()
                .resolve(Some(&store.index().unwrap()), None)
                .stamp
                .unavailable
        );
    }

    #[test]
    fn imports_are_atomic_and_edits_reject_duplicates_in_the_same_scope() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        let input = |name: &str| Input {
            name: name.into(),
            value: "secret".into(),
            secret: true,
        };
        store
            .save(
                USER,
                (0..10).map(|i| input(&format!("KEY_{i}"))).collect(),
                None,
            )
            .unwrap();
        assert_eq!(store.resolve(None).unwrap().values.len(), 10);
        assert!(store
            .save(USER, vec![input("NEW"), input("KEY_0")], None)
            .is_err());
        assert!(!store.resolve(None).unwrap().values.contains_key("NEW"));
        assert!(store
            .save(USER, vec![input("DUP"), input("DUP")], None)
            .is_err());
        assert!(store
            .save(USER, vec![input("KEY_1")], Some("KEY_0"))
            .is_err());
        assert!(store.resolve(None).unwrap().values.contains_key("KEY_0"));
        store
            .save(USER, vec![input("RENAMED")], Some("KEY_0"))
            .unwrap();
        assert!(!store.resolve(None).unwrap().values.contains_key("KEY_0"));
        store.save("repo", vec![input("KEY_1")], None).unwrap();
        assert_eq!(store.resolve(Some("repo".into())).unwrap().values.len(), 10);
    }

    #[test]
    fn concurrent_writes_keep_both_changes() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        std::thread::scope(|threads| {
            for name in ["FIRST", "SECOND"] {
                let secrets = &secrets;
                let root = dir.path().to_path_buf();
                threads.spawn(move || add(&Store { root, secrets }, USER, name, "secret"));
            }
        });
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        assert_eq!(store.resolve(None).unwrap().values.len(), 2);
    }

    #[test]
    fn failed_keychain_write_keeps_old_values_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "old");
        let before = store.resolve(None).unwrap();
        secrets.fail_writes(true);
        assert!(store
            .change(USER, |values| {
                values.insert("KEY".into(), "new-secret".into());
                Ok(())
            })
            .is_err());
        let after = store.resolve(None).unwrap();
        assert!(before.stamp == after.stamp);
        assert_eq!(after.values["KEY"], "old");
    }

    #[test]
    fn failed_index_write_keeps_the_previous_keychain_item() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "old");
        let before = store.resolve(None).unwrap();
        // Occupy write_atomic's temporary filename with a directory.
        std::fs::create_dir(
            dir.path()
                .join(format!("environment.tmp.{}", std::process::id())),
        )
        .unwrap();
        assert!(store
            .change(USER, |values| {
                values.insert("KEY".into(), "new".into());
                Ok(())
            })
            .is_err());
        let after = store.resolve(None).unwrap();
        assert_eq!(after.values["KEY"], "old");
        assert!(before.stamp == after.stamp);
    }

    #[test]
    fn invalid_names_reserved_names_and_nul_fail_before_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        for name in [
            "",
            "lower",
            "1KEY",
            "A=B",
            "A-B",
            "A\n",
            "TERMINALX_NEXT_TOKEN",
            "RACCOON_TAB_ID",
            "CODEX_HOME",
            "PATH",
            "TERM",
            "HOME",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "CLAUDECODE",
        ] {
            assert!(validate_name(name).is_err(), "{name}");
        }
        for name in ["API_KEY", "_KEY", "A1"] {
            validate_name(name).unwrap();
        }
        assert!(store
            .change(USER, |values| {
                values.insert("KEY".into(), "bad\0value".into());
                Ok(())
            })
            .is_err());
        assert!(secrets.calls().is_empty());
        assert!(!dir.path().join("environment.json").exists());
    }

    #[test]
    fn missing_or_invalid_keychain_items_are_rejected_without_echoing_values() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "sensitive-value");
        let scope = store.index().unwrap()[USER].clone();
        secrets
            .set(SERVICE, &scope.revision, b"sensitive-value")
            .unwrap();
        let error = store.resolve(None).err().unwrap().to_string();
        assert!(!error.contains("sensitive-value"));
        secrets.delete(SERVICE, &scope.revision).unwrap();
        assert!(store.resolve(None).is_err());
        std::fs::write(dir.path().join("environment.json"), b"sensitive-value").unwrap();
        assert!(!store
            .resolve(None)
            .err()
            .unwrap()
            .to_string()
            .contains("sensitive-value"));
    }

    #[test]
    fn git_worktrees_subdirectories_and_symlinks_share_a_scope() {
        let repo = tempfile::tempdir().unwrap();
        crate::git::run(repo.path(), &["init", "-q"]).unwrap();
        crate::git::run(
            repo.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        )
        .unwrap();
        let worktrees = tempfile::tempdir().unwrap();
        let worktree = worktrees.path().join("worktree");
        crate::git::run(
            repo.path(),
            &["worktree", "add", "--detach", worktree.to_str().unwrap()],
        )
        .unwrap();
        let subdir = worktree.join("subdir");
        std::fs::create_dir(&subdir).unwrap();
        assert!(repository(repo.path()).is_some());
        assert_eq!(repository(repo.path()), repository(&subdir));
        #[cfg(unix)]
        {
            let link = worktrees.path().join("link");
            std::os::unix::fs::symlink(&worktree, &link).unwrap();
            assert_eq!(repository(repo.path()), repository(&link));
        }
        assert_ne!(repository(repo.path()), repository(worktrees.path()));
    }

    #[test]
    fn env_file_read_is_bounded_and_rejects_non_files() {
        let repo = tempfile::tempdir().unwrap();
        crate::git::run(repo.path(), &["init", "-q"]).unwrap();
        let project = repo.path().to_str().unwrap();
        let file = repo.path().join(".env");
        std::fs::write(&file, "KEY=secret").unwrap();
        assert_eq!(
            read_env_file(project, file.to_str().unwrap()).unwrap(),
            "KEY=secret"
        );
        std::fs::write(&file, vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert!(read_env_file(project, file.to_str().unwrap()).is_err());
        let outside = tempfile::tempdir().unwrap();
        let other = outside.path().join(".env");
        std::fs::write(&other, "KEY=outside").unwrap();
        assert!(read_env_file(project, other.to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            let link = repo.path().join(".env.link");
            std::os::unix::fs::symlink(&other, &link).unwrap();
            assert!(read_env_file(project, link.to_str().unwrap()).is_err());
        }
        std::fs::write(&file, [0xff]).unwrap();
        assert!(read_env_file(project, file.to_str().unwrap()).is_err());
        assert!(read_env_file(project, project).is_err());
        #[cfg(unix)]
        {
            let fifo = repo.path().join(".env.fifo");
            let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            // SAFETY: a valid, NUL-terminated path in this test's private directory.
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            assert!(read_env_file(project, fifo.to_str().unwrap()).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolved_values_reach_shell_agent_and_archive_ptys_literally() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "TEST_KEY", "user");
        add(
            &store,
            "repo",
            "TEST_KEY",
            "$(touch must-not-exist); 'quoted'\nsecond line",
        );
        for id in ["session:1", "tab:agent", "archive:1"] {
            let launch = store.resolve(Some("repo".into())).unwrap();
            let expected = launch.values["TEST_KEY"].clone();
            TEST_LAUNCH.with(|slot| *slot.borrow_mut() = Some(launch));
            let terminals = crate::pty::Terminals::new();
            let sink = std::sync::Arc::new(crate::sink::BroadcastSink::new(64));
            let spec = crate::pty::PaneSpec {
                cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24,
                command: Some("/usr/bin/printf '%s' \"$TEST_KEY\""), env: &[],
            };
            if id.starts_with("archive:") {
                let file = dir.path().join("archive.sh");
                std::fs::write(&file, spec.command.unwrap()).unwrap();
                terminals.spawn_program(sink, id, spec, std::ffi::OsStr::new("/bin/sh"), &[file.as_os_str()], &|| {}).unwrap();
            } else {
                terminals.spawn(sink, id, spec).unwrap();
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                let output = String::from_utf8(terminals.read_output(id).unwrap_or_default())
                    .unwrap()
                    .replace("\r\n", "\n");
                if output.contains(&expected) {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the PTY did not receive the resolved value"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            terminals.kill_all();
            assert!(!dir.path().join("must-not-exist").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn archive_does_not_start_without_its_configured_environment() {
        let dir = tempfile::tempdir().unwrap();
        TEST_LAUNCH.with(|slot| *slot.borrow_mut() = Some(Launch {
            values: Values::new(), stamp: Stamp { unavailable: true, ..Default::default() },
        }));
        let terminals = crate::pty::Terminals::new();
        let started = std::cell::Cell::new(false);
        let script = dir.path().join("archive.sh");
        std::fs::write(&script, "touch archive-ran").unwrap();
        let error = terminals.spawn_program(
            std::sync::Arc::new(crate::sink::BroadcastSink::new(64)), "archive:unavailable",
            crate::pty::PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: None, env: &[] },
            std::ffi::OsStr::new("/bin/sh"), &[script.as_os_str()], &|| started.set(true),
        ).unwrap_err();
        assert!(format!("{error:#}").contains("Environment overrides are unavailable"));
        assert!(!started.get());
        assert!(!dir.path().join("archive-ran").exists());
        assert!(terminals.panes().is_empty());
    }
}
