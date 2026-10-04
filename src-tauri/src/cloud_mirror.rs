//! The local mirror of a cloud workspace, on disk (PRO-25,
//! docs/CLOUD-MIRROR.md): an app-owned, one-way copy of the workspace's
//! files. This module only writes what it is handed; the sync loop that
//! reads the workspace lives in the frontend.
//!
//! `<TerminalX home>/cloud-mirrors/<organization id>/<workspace id>/`:
//!
//! - `files/`: the mirrored tree;
//! - `mirror.json`: the ownership record: every path the mirror wrote, with
//!   the content hash it wrote and the last successful revision;
//! - `staging/`: files read from the workspace and verified, not yet in place;
//! - `journal.json`: a publish in progress;
//! - `exports/<time>/`: local versions a person asked to keep before discarding.
//!
//! Rules that always hold:
//!
//! - Nothing is written outside `files/` (and the mirror's own bookkeeping).
//!   A path is refused if it is not plain relative components, names Git
//!   metadata or a secret, or has a symbolic link for a parent inside the
//!   mirror.
//! - Only paths the mirror wrote are ever removed.
//! - A local change is never overwritten: a file the mirror wrote that was
//!   edited or deleted, or a local file where the workspace now has one, is
//!   a divergence. While there is any, nothing is published. It is resolved
//!   only by `resolve` (discard, or export then discard), for exactly the
//!   paths that were divergent then.
//! - Each file appears whole or not at all (staged, then renamed). The tree
//!   is not one transaction: a publish that dies leaves `journal.json`, and
//!   the next plan fetches those paths again instead of calling them
//!   divergent.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DIR: &str = "cloud-mirrors";
const FILES: &str = "files";
const STAGING: &str = "staging";
const RECORD: &str = "mirror.json";
const JOURNAL: &str = "journal.json";
const EXPORTS: &str = "exports";
/// Divergent paths listed in one answer; the total is always given.
const MAX_LISTED: usize = 200;
/// Largest file a mirror holds, `fs.read`'s limit.
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

/// One file of the workspace's manifest (`mirror.manifest`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub version: String,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub repo: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
}

/// The workspace's file set, as the frontend read it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub manifest_id: String,
    #[serde(default)]
    pub repositories: Vec<Repository>,
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub truncated: bool,
}

/// The last sync that was published in full.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub manifest_id: String,
    pub at_ms: u64,
    pub files: usize,
    pub bytes: u64,
    pub repositories: Vec<Repository>,
}

/// Size and modification time of a file as the mirror left it: a cheap way
/// to tell an untouched file without hashing it on every scan.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Signature {
    size: u64,
    modified_ns: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owned {
    version: String,
    etag: String,
    size: u64,
    executable: bool,
    local: Signature,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    v: u8,
    organization_id: String,
    workspace_id: String,
    enabled: bool,
    #[serde(default)]
    owned: BTreeMap<String, Owned>,
    #[serde(default)]
    revision: Option<Revision>,
    /// Divergent paths a person chose to replace with the workspace's.
    #[serde(default)]
    discard: BTreeSet<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    manifest_id: String,
    paths: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    pub path: String,
    /// `modified`, `deleted`, `replaced` (no longer a plain file) or
    /// `in-the-way` (a local file where the workspace now has one).
    pub reason: &'static str,
}

/// What a sync would do.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Paths to read from the workspace and stage.
    pub fetch: Vec<String>,
    pub fetch_bytes: u64,
    /// Files the mirror wrote that the workspace no longer has.
    pub remove: usize,
    pub unchanged: usize,
    pub diverged: Vec<Divergence>,
    pub diverged_total: usize,
    /// Left out here although the workspace listed them: a secret by name,
    /// or a name that differs only by case from another on this disk.
    pub refused: usize,
    pub up_to_date: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// Where the mirrored files are, for the UI only.
    pub root: String,
    pub revision: Option<Revision>,
    pub files: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub status: Status,
    /// Not empty: nothing was written.
    pub diverged: Vec<Divergence>,
    pub diverged_total: usize,
    pub written: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Resolution {
    Discard,
    Export,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub paths: usize,
    /// Where the local versions were copied, for `export`.
    pub exported_to: Option<String>,
}

pub struct Mirror {
    dir: PathBuf,
    organization_id: String,
    workspace_id: String,
}

/// An id is a directory name here: only what cannot leave its parent.
fn valid_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) && !id.starts_with('-')
}

pub fn etag(bytes: &[u8]) -> String {
    Sha256::digest(bytes)[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

fn etag_of_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize()[..16].iter().map(|byte| format!("{byte:02x}")).collect())
}

fn signature(meta: &std::fs::Metadata) -> Signature {
    let modified_ns = meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|elapsed| elapsed.as_nanos()).unwrap_or(0);
    Signature { size: meta.len(), modified_ns }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

/// The relative path's components, or a refusal: plain names only, nothing
/// reserved, nothing secret.
fn components(relative: &str) -> Result<Vec<&str>> {
    if relative.is_empty() || relative.len() > 4096 || relative.contains(['\0', '\\']) {
        bail!("invalid path");
    }
    let parts: Vec<&str> = relative.split('/').collect();
    let plain = |part: &&str| !part.is_empty() && matches!(Path::new(part).components().collect::<Vec<_>>().as_slice(), [Component::Normal(_)]);
    if !parts.iter().all(plain) {
        bail!("the path is not workspace-relative");
    }
    if crate::mirror_rules::reserved(relative) {
        bail!("Git metadata is never mirrored");
    }
    if crate::mirror_rules::secret(relative) {
        bail!("a secret is never mirrored");
    }
    Ok(parts)
}

/// What is at a path inside the mirror.
enum Local {
    Missing,
    File(std::fs::Metadata),
    /// A link, a directory or anything else that is not a plain file.
    Other,
}

impl Mirror {
    /// The mirror of one workspace under `home`. Creates nothing.
    pub fn at(home: &Path, organization_id: &str, workspace_id: &str) -> Result<Self> {
        if !valid_id(organization_id) || !valid_id(workspace_id) {
            bail!("invalid workspace");
        }
        Ok(Self { dir: home.join(DIR).join(organization_id).join(workspace_id), organization_id: organization_id.into(), workspace_id: workspace_id.into() })
    }

    fn files(&self) -> PathBuf {
        self.dir.join(FILES)
    }

    fn record(&self) -> Result<Option<Record>> {
        let bytes = match std::fs::read(self.dir.join(RECORD)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("read the mirror's record"),
        };
        let record: Record = serde_json::from_slice(&bytes).context("the mirror's record is unreadable")?;
        if record.organization_id != self.organization_id || record.workspace_id != self.workspace_id {
            bail!("this directory mirrors another workspace");
        }
        Ok(Some(record))
    }

    fn enabled_record(&self) -> Result<Record> {
        self.record()?.filter(|record| record.enabled).ok_or_else(|| anyhow!("the mirror is off"))
    }

    fn save(&self, record: &Record) -> Result<()> {
        crate::store::write_json(&self.dir.join(RECORD), record)
    }

    fn journal(&self) -> BTreeSet<String> {
        std::fs::read(self.dir.join(JOURNAL)).ok().and_then(|bytes| serde_json::from_slice::<Journal>(&bytes).ok()).map(|journal| journal.paths).unwrap_or_default()
    }

    fn status_of(&self, record: Option<&Record>) -> Status {
        Status {
            enabled: record.is_some_and(|record| record.enabled),
            root: self.files().to_string_lossy().into_owned(),
            revision: record.and_then(|record| record.revision.clone()),
            files: record.map_or(0, |record| record.owned.len()),
        }
    }

    pub fn status(&self) -> Result<Status> {
        Ok(self.status_of(self.record()?.as_ref()))
    }

    /// Turn the mirror on. Nothing is copied until a sync publishes.
    pub fn enable(&self) -> Result<Status> {
        crate::store::ensure_dir(self.dir.clone())?;
        crate::store::ensure_dir(self.files())?;
        let mut record = self.record()?.unwrap_or(Record {
            v: 1,
            organization_id: self.organization_id.clone(),
            workspace_id: self.workspace_id.clone(),
            enabled: true,
            owned: BTreeMap::new(),
            revision: None,
            discard: BTreeSet::new(),
        });
        record.enabled = true;
        self.save(&record)?;
        Ok(self.status_of(Some(&record)))
    }

    /// Turn the mirror off. With `remove_files`, the mirrored tree and its
    /// record go too; exports a person asked for stay.
    pub fn disable(&self, remove_files: bool) -> Result<Status> {
        let Some(mut record) = self.record()? else { return self.status() };
        if remove_files {
            for name in [FILES, STAGING] {
                match std::fs::remove_dir_all(self.dir.join(name)) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error).context("remove the mirrored files"),
                    _ => {}
                }
            }
            let _ = std::fs::remove_file(self.dir.join(JOURNAL));
            let _ = std::fs::remove_file(self.dir.join(RECORD));
            return self.status();
        }
        record.enabled = false;
        self.save(&record)?;
        Ok(self.status_of(Some(&record)))
    }

    /// Where `relative` lives in the mirror. Refuses a path through a
    /// symbolic link: a link planted in the mirror must never redirect a write.
    fn local_path(&self, relative: &str) -> Result<PathBuf> {
        let parts = components(relative)?;
        let mut path = self.files();
        for part in &parts[..parts.len() - 1] {
            path.push(part);
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => bail!("a symbolic link is in the mirror at {}", path.strip_prefix(self.files()).unwrap_or(&path).display()),
                Ok(meta) if !meta.is_dir() => bail!("a file is in the way of a folder at {}", path.strip_prefix(self.files()).unwrap_or(&path).display()),
                _ => {}
            }
        }
        path.push(parts[parts.len() - 1]);
        Ok(path)
    }

    fn look(&self, relative: &str) -> Result<Local> {
        let path = self.local_path(relative)?;
        Ok(match std::fs::symlink_metadata(&path) {
            Err(_) => Local::Missing,
            Ok(meta) if meta.is_file() => Local::File(meta),
            Ok(_) => Local::Other,
        })
    }

    /// Whether a file the mirror wrote is still what it wrote.
    fn divergence_of(&self, path: &str, owned: &Owned) -> Result<Option<&'static str>> {
        Ok(match self.look(path)? {
            Local::Missing => Some("deleted"),
            Local::Other => Some("replaced"),
            Local::File(meta) if signature(&meta) == owned.local => None,
            // Touched: only a different content is a change.
            Local::File(_) => (etag_of_file(&self.local_path(path)?)? != owned.etag).then_some("modified"),
        })
    }

    /// Local changes to the files the mirror wrote, without asking the
    /// workspace anything.
    pub fn check(&self) -> Result<(Vec<Divergence>, usize)> {
        let record = self.enabled_record()?;
        let pending = self.journal();
        let mut diverged = Vec::new();
        for (path, owned) in &record.owned {
            if pending.contains(path) || record.discard.contains(path) {
                continue;
            }
            if let Some(reason) = self.divergence_of(path, owned)? {
                diverged.push(Divergence { path: path.clone(), reason });
            }
        }
        let total = diverged.len();
        diverged.truncate(MAX_LISTED);
        Ok((diverged, total))
    }

    /// Does this disk treat `A` and `a` as one name?
    fn case_insensitive(&self) -> bool {
        let probe = self.dir.join(".TerminalX-Case-Probe");
        if std::fs::write(&probe, b"").is_err() {
            return false;
        }
        let folded = self.dir.join(".terminalx-case-probe").exists();
        let _ = std::fs::remove_file(&probe);
        folded
    }

    /// The entries this mirror will hold, and how many were refused here.
    fn desired<'a>(&self, manifest: &'a Manifest) -> Result<(BTreeMap<&'a str, &'a Entry>, usize)> {
        if manifest.truncated {
            bail!("the workspace has more files than a mirror holds");
        }
        let fold = self.case_insensitive();
        let mut seen = BTreeSet::new();
        let mut desired = BTreeMap::new();
        let mut refused = 0;
        let mut sorted: Vec<&Entry> = manifest.entries.iter().collect();
        sorted.sort_by(|a, b| a.path.cmp(&b.path));
        for entry in sorted {
            if entry.size as usize > MAX_FILE_BYTES {
                bail!("the manifest lists a file larger than a mirror holds");
            }
            if crate::mirror_rules::secret(&entry.path) {
                refused += 1;
                continue;
            }
            // Anything else that is not a plain relative path is a broken manifest.
            components(&entry.path).with_context(|| format!("the manifest names {}", entry.path))?;
            if fold && !seen.insert(entry.path.to_lowercase()) {
                refused += 1;
                continue;
            }
            if desired.insert(entry.path.as_str(), entry).is_some() {
                bail!("the manifest names {} twice", entry.path);
            }
        }
        Ok((desired, refused))
    }

    fn plan_with(&self, record: &Record, manifest: &Manifest) -> Result<(Plan, Vec<Divergence>, Vec<String>)> {
        let (desired, refused) = self.desired(manifest)?;
        let pending = self.journal();
        let forced = |path: &str| pending.contains(path) || record.discard.contains(path);
        let mut diverged = Vec::new();
        let mut fetch = Vec::new();
        let mut fetch_bytes = 0;
        let mut unchanged = 0;
        for (path, entry) in &desired {
            let owned = record.owned.get(*path);
            let local_change = match owned {
                Some(owned) if !forced(path) => self.divergence_of(path, owned)?,
                Some(_) => None,
                None if forced(path) => None,
                None => match self.look(path)? {
                    Local::Missing => None,
                    _ => Some("in-the-way"),
                },
            };
            if let Some(reason) = local_change {
                diverged.push(Divergence { path: (*path).to_string(), reason });
                continue;
            }
            let current = owned.is_some_and(|owned| owned.version == entry.version && owned.executable == entry.executable);
            if current && !forced(path) {
                unchanged += 1;
            } else {
                fetch.push((*path).to_string());
                fetch_bytes += entry.size;
            }
        }
        let mut remove = Vec::new();
        for (path, owned) in &record.owned {
            if desired.contains_key(path.as_str()) {
                continue;
            }
            match if forced(path) { None } else { self.divergence_of(path, owned)? } {
                // Gone on both sides: nothing to keep, nothing to remove.
                Some("deleted") => remove.push(path.clone()),
                Some(reason) => diverged.push(Divergence { path: path.clone(), reason }),
                None => remove.push(path.clone()),
            }
        }
        diverged.sort_by(|a, b| a.path.cmp(&b.path));
        let up_to_date = fetch.is_empty() && remove.is_empty() && diverged.is_empty() && record.revision.as_ref().is_some_and(|revision| revision.manifest_id == manifest.manifest_id);
        let plan = Plan {
            fetch,
            fetch_bytes,
            remove: remove.len(),
            unchanged,
            diverged_total: diverged.len(),
            diverged: diverged.iter().take(MAX_LISTED).cloned().collect(),
            refused,
            up_to_date,
        };
        Ok((plan, diverged, remove))
    }

    /// What a sync to `manifest` would read, remove and refuse. Writes nothing.
    pub fn plan(&self, manifest: &Manifest) -> Result<Plan> {
        let record = self.enabled_record()?;
        Ok(self.plan_with(&record, manifest)?.0)
    }

    fn staged(&self, relative: &str, etag: &str) -> PathBuf {
        let name: String = Sha256::digest(relative.as_bytes())[..16].iter().map(|byte| format!("{byte:02x}")).collect();
        self.dir.join(STAGING).join(format!("{name}.{etag}"))
    }

    /// Keep one file read from the workspace, once its bytes match the hash
    /// the workspace reported. Nothing in `files/` changes.
    pub fn stage(&self, relative: &str, bytes: &[u8], reported_etag: &str) -> Result<()> {
        self.enabled_record()?;
        components(relative)?;
        if bytes.len() > MAX_FILE_BYTES {
            bail!("the file is larger than a mirror holds");
        }
        if reported_etag.len() != 32 || !reported_etag.bytes().all(|byte| byte.is_ascii_hexdigit()) || etag(bytes) != reported_etag.to_ascii_lowercase() {
            bail!("the file's content does not match its hash");
        }
        crate::store::ensure_dir(self.dir.join(STAGING))?;
        crate::store::write_atomic(&self.staged(relative, &reported_etag.to_ascii_lowercase()), bytes)
    }

    /// Put a sync in place: every staged file by rename, then remove what
    /// the workspace no longer has, then commit the record. With any
    /// divergence nothing is written.
    pub fn publish(&self, manifest: &Manifest, etags: &BTreeMap<String, String>) -> Result<Published> {
        let mut record = self.enabled_record()?;
        let (plan, diverged, remove) = self.plan_with(&record, manifest)?;
        if !diverged.is_empty() {
            return Ok(Published { status: self.status_of(Some(&record)), diverged: plan.diverged, diverged_total: plan.diverged_total, written: 0, removed: 0 });
        }
        let entries: BTreeMap<&str, &Entry> = manifest.entries.iter().map(|entry| (entry.path.as_str(), entry)).collect();
        // Everything is here and verified before the first file moves.
        let mut moves = Vec::new();
        for path in &plan.fetch {
            let etag = etags.get(path).map(|etag| etag.to_ascii_lowercase()).ok_or_else(|| anyhow!("{path} was not read"))?;
            let staged = self.staged(path, &etag);
            if etag_of_file(&staged).map_err(|_| anyhow!("{path} was not read"))? != etag {
                bail!("{path} changed after it was read");
            }
            moves.push((path.clone(), staged, etag));
        }
        let journal = Journal { manifest_id: manifest.manifest_id.clone(), paths: plan.fetch.iter().chain(remove.iter()).cloned().collect() };
        crate::store::write_json(&self.dir.join(JOURNAL), &journal)?;

        for (path, staged, etag) in &moves {
            let entry = entries[path.as_str()];
            let target = self.local_path(path)?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).with_context(|| format!("create the folder of {path}"))?;
            }
            // A folder where a file belongs is never removed for it.
            if std::fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_dir()) {
                bail!("a local folder is in the way at {path}; move it, then sync again");
            }
            set_mode(staged, entry.executable)?;
            std::fs::rename(staged, &target).with_context(|| format!("put {path} in place"))?;
            let meta = std::fs::symlink_metadata(&target)?;
            record.owned.insert(path.clone(), Owned { version: entry.version.clone(), etag: etag.clone(), size: meta.len(), executable: entry.executable, local: signature(&meta) });
        }
        for path in &remove {
            let target = self.local_path(path)?;
            match std::fs::symlink_metadata(&target) {
                Ok(meta) if meta.is_dir() => bail!("a local folder is in the way at {path}; move it, then sync again"),
                Ok(_) => std::fs::remove_file(&target).with_context(|| format!("remove {path}"))?,
                Err(_) => {}
            }
            self.prune_empty_parents(&target);
            record.owned.remove(path);
        }
        record.discard.clear();
        record.revision = Some(Revision {
            manifest_id: manifest.manifest_id.clone(),
            at_ms: now_ms(),
            files: record.owned.len(),
            bytes: record.owned.values().map(|owned| owned.size).sum(),
            repositories: manifest.repositories.clone(),
        });
        self.save(&record)?;
        let _ = std::fs::remove_file(self.dir.join(JOURNAL));
        let _ = std::fs::remove_dir_all(self.dir.join(STAGING));
        Ok(Published { status: self.status_of(Some(&record)), diverged: Vec::new(), diverged_total: 0, written: moves.len(), removed: remove.len() })
    }

    /// Remove folders the last removal left empty, up to `files/`.
    fn prune_empty_parents(&self, target: &Path) {
        let root = self.files();
        let mut dir = target.parent();
        while let Some(current) = dir.filter(|current| *current != root && current.starts_with(&root)) {
            if std::fs::remove_dir(current).is_err() {
                break;
            }
            dir = current.parent();
        }
    }

    /// A person's deliberate answer to a divergence: the paths divergent now
    /// will be replaced by the workspace's versions on the next sync. With
    /// `Export` their local versions are copied aside first.
    pub fn resolve(&self, manifest: &Manifest, resolution: Resolution) -> Result<Resolved> {
        let mut record = self.enabled_record()?;
        let (_, diverged, _) = self.plan_with(&record, manifest)?;
        let mut exported_to = None;
        if resolution == Resolution::Export && !diverged.is_empty() {
            let destination = self.dir.join(EXPORTS).join(now_ms().to_string());
            for item in &diverged {
                let source = self.local_path(&item.path)?;
                if !std::fs::symlink_metadata(&source).is_ok_and(|meta| meta.is_file()) {
                    continue;
                }
                let target = destination.join(&item.path);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&source, &target).with_context(|| format!("export {}", item.path))?;
            }
            exported_to = Some(destination.to_string_lossy().into_owned());
        }
        for item in &diverged {
            // A local folder is never discarded for a file.
            if matches!(self.look(&item.path)?, Local::Other) && std::fs::symlink_metadata(self.local_path(&item.path)?).is_ok_and(|meta| meta.is_dir()) {
                bail!("a local folder is in the way at {}; move it, then sync again", item.path);
            }
            record.discard.insert(item.path.clone());
        }
        self.save(&record)?;
        Ok(Resolved { paths: diverged.len(), exported_to })
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 })).context("set the file's mode")
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _executable: bool) -> Result<()> {
    Ok(())
}

#[cfg(test)]
#[path = "cloud_mirror_tests.rs"]
mod tests;
