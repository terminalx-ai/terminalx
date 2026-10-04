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
//! The workspace is not trusted (other people's agents run there). What it
//! lists is checked again here, and "verified" below means intact in
//! transit, never authentic or safe.
//!
//! Rules that always hold:
//!
//! - Nothing is written outside `files/` (and the mirror's own bookkeeping).
//!   A path is refused if it is not plain relative components, names Git
//!   metadata, a secret or tool configuration that runs by itself, lies in
//!   a folder Git would take for a repository's own directory, is too long
//!   or deep for this disk, or has a symbolic link for a parent inside the
//!   mirror. None of the mirror's own directories may be a link either.
//! - No mirrored file is executable, and on macOS each one is quarantined.
//! - A mirror is bounded: files, total bytes, depth, and free disk space.
//! - Only paths the mirror wrote are ever removed.
//! - A local change is never overwritten: a file the mirror wrote that was
//!   edited or deleted, or a local file where the workspace now has one, is
//!   a divergence. While there is any, nothing is published. It is resolved
//!   only by `resolve` (discard, or export then discard), for exactly the
//!   paths that were divergent then.
//! - Each file appears whole or not at all (staged, then renamed). The tree
//!   is not one transaction. A publish that fails records what it did move
//!   and removes its journal; one that dies leaves `journal.json`, which the
//!   next call consumes once: a journaled file whose content is what was
//!   being written is adopted, anything else is left to the ordinary
//!   divergence check. A journal never exempts a path from that check.

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
/// A mirror's bounds, enforced here whatever the workspace says of itself.
pub const MAX_FILES: usize = 50_000;
pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
/// What every common filesystem takes for one name, and macOS for a path.
const MAX_NAME_BYTES: usize = 255;
const MAX_PATH_BYTES: usize = 1024;
/// Free space left on the disk after a sync, at least.
const FREE_DISK_FLOOR: u64 = 1024 * 1024 * 1024;

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
    /// Divergent paths a person chose to replace with the workspace's, each
    /// with what was there when they chose (its content hash, `missing` or
    /// `other`). The choice covers that state only: an edit made afterwards
    /// is a new divergence.
    #[serde(default)]
    discard: BTreeMap<String, String>,
    /// Paths the check of the disk after a publish removed (they turned out
    /// to be part of a Git directory, or tool configuration, as the disk
    /// spells them). Never written again.
    #[serde(default)]
    blocked: BTreeSet<String>,
}

/// One file a publish is about to put in place.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Write {
    etag: String,
    version: String,
}

/// A publish in progress: enough to tell, after a crash, which of its files
/// did arrive.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    manifest_id: String,
    #[serde(default)]
    writes: BTreeMap<String, Write>,
    #[serde(default)]
    deletes: BTreeSet<String>,
}

/// Why this side left out a file the workspace listed.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    pub secret: usize,
    pub tool_config: usize,
    pub git_directory: usize,
    /// One name with another on this disk (case, Unicode form), or a file where another entry needs a folder.
    pub collision: usize,
    /// A name, path or depth this disk or the mirror does not take.
    pub too_long: usize,
    /// Not a plain relative path.
    pub invalid: usize,
    /// Removed by the check of the disk after an earlier publish.
    pub on_disk: usize,
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
    /// Left out here although the workspace listed them, by reason.
    pub refused: Refused,
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
    /// Files this publish wrote and then took back, because on the disk
    /// they turned out to be something a mirror never holds.
    pub taken_back: usize,
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

/// The relative path's components, or a refusal: plain names only.
fn lexical(relative: &str) -> Result<Vec<&str>> {
    if relative.is_empty() || relative.len() > 4096 || relative.contains(['\0', '\\']) {
        bail!("invalid path");
    }
    let parts: Vec<&str> = relative.split('/').collect();
    let plain = |part: &&str| !part.is_empty() && matches!(Path::new(part).components().collect::<Vec<_>>().as_slice(), [Component::Normal(_)]);
    if !parts.iter().all(plain) {
        bail!("the path is not workspace-relative");
    }
    Ok(parts)
}

/// [`lexical`], and nothing a mirror never holds by its own name. (Whether
/// it lies in a Git directory depends on the other paths: see `desired`.)
fn components(relative: &str) -> Result<Vec<&str>> {
    let parts = lexical(relative)?;
    if crate::mirror_rules::reserved(relative) {
        bail!("Git metadata is never mirrored");
    }
    if crate::mirror_rules::secret(relative) {
        bail!("a secret is never mirrored");
    }
    if crate::mirror_rules::tool_config(relative) {
        bail!("tool configuration that runs by itself is never mirrored");
    }
    if crate::mirror_rules::git_pointer(relative) {
        bail!("a file that points Git at another folder is never mirrored");
    }
    if parts.len() > MAX_DEPTH || parts.iter().any(|part| part.len() > MAX_NAME_BYTES) {
        bail!("the path is too long or too deep");
    }
    Ok(parts)
}

/// What makes two names one file on this disk: always the composed Unicode
/// form, and where the disk folds case, Unicode's case folding (not ASCII
/// lower-casing: the long s is `s` there, the final sigma is sigma).
fn fold(path: &str, case: bool) -> String {
    if case {
        path.split('/').map(crate::mirror_rules::fold).collect::<Vec<_>>().join("/")
    } else {
        icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(path).into_owned()
    }
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
        // Canonical, so a link in the way of the home itself is resolved once, here.
        let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
        Ok(Self { dir: home.join(DIR).join(organization_id).join(workspace_id), organization_id: organization_id.into(), workspace_id: workspace_id.into() })
    }

    /// None of the mirror's own directories may be a symbolic link: a write
    /// or a removal would follow it out of the mirror.
    fn guard(&self) -> Result<()> {
        let workspace = &self.dir;
        let organization = workspace.parent().unwrap_or(workspace);
        let mirrors = organization.parent().unwrap_or(organization);
        for dir in [mirrors.to_path_buf(), organization.to_path_buf(), workspace.clone(), self.files(), self.dir.join(STAGING), self.dir.join(EXPORTS)] {
            if std::fs::symlink_metadata(&dir).is_ok_and(|meta| meta.file_type().is_symlink()) {
                bail!("{} is a symbolic link; a mirror is never written through one", dir.display());
            }
        }
        Ok(())
    }

    fn files(&self) -> PathBuf {
        self.dir.join(FILES)
    }

    fn record(&self) -> Result<Option<Record>> {
        self.guard()?;
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

    /// Consume the journal of a publish that died, once. A file it was
    /// writing whose content is now what it was writing did arrive and is
    /// adopted; a file it was removing that is gone is forgotten. Everything
    /// else keeps its old record, so the ordinary divergence check decides.
    fn recover(&self, record: &mut Record) -> Result<()> {
        let path = self.dir.join(JOURNAL);
        let Ok(bytes) = std::fs::read(&path) else { return Ok(()) };
        if let Ok(journal) = serde_json::from_slice::<Journal>(&bytes) {
            for (relative, write) in &journal.writes {
                let Ok(Local::File(meta)) = self.look(relative) else { continue };
                if etag_of_file(&self.local_path_unchecked(relative)?).is_ok_and(|etag| etag == write.etag) {
                    record.owned.insert(relative.clone(), Owned { version: write.version.clone(), etag: write.etag.clone(), size: meta.len(), local: signature(&meta) });
                }
            }
            for relative in &journal.deletes {
                if matches!(self.look(relative), Ok(Local::Missing)) {
                    record.owned.remove(relative);
                }
            }
            self.save(record)?;
        }
        std::fs::remove_file(&path).context("remove the journal")?;
        let _ = std::fs::remove_dir_all(self.dir.join(STAGING));
        Ok(())
    }

    /// The enabled record, with any journal of a dead publish consumed.
    fn working_record(&self) -> Result<Record> {
        let mut record = self.enabled_record()?;
        self.recover(&mut record)?;
        Ok(record)
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

    /// Turn the mirror on for `account`, and record that the mirrors on this
    /// computer are that account's. Without this a mirror made after the
    /// app's launch would have no owner, and the next account to arrive
    /// would inherit it. Mirrors of anyone else are removed first.
    pub fn enable_as(&self, account: &str) -> Result<Status> {
        if account.is_empty() {
            bail!("sign in to turn on a local mirror");
        }
        self.guard()?;
        let home = self.dir.ancestors().nth(3).ok_or_else(|| anyhow!("no home directory"))?.to_path_buf();
        claim_owner(&home, account, None)?;
        crate::store::ensure_dir(home.join(DIR))?;
        crate::store::write_atomic(&home.join(DIR).join(OWNER), owner_record(account).as_bytes())?;
        self.enable()
    }

    /// Turn the mirror on. Nothing is copied until a sync publishes.
    fn enable(&self) -> Result<Status> {
        self.guard()?;
        crate::store::ensure_dir(self.dir.clone())?;
        crate::store::ensure_dir(self.files())?;
        let mut record = self.record()?.unwrap_or(Record {
            v: 1,
            organization_id: self.organization_id.clone(),
            workspace_id: self.workspace_id.clone(),
            enabled: true,
            owned: BTreeMap::new(),
            revision: None,
            discard: BTreeMap::new(),
            blocked: BTreeSet::new(),
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
            self.guard()?;
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

    /// Remove the mirrored copy because the person may no longer have it
    /// (access revoked, signed out, another account, the workspace deleted).
    /// By the record only: every file the mirror wrote, its staging, journal
    /// and record. A mirrored file the person edited is their work: it is
    /// moved to `exports/<time>/`, not deleted. Files they added themselves
    /// and their earlier exports stay.
    pub fn purge(&self) -> Result<usize> {
        let Some(record) = self.record()? else { return Ok(0) };
        let exports = self.dir.join(EXPORTS).join(now_ms().to_string());
        let mut removed = 0;
        for (path, owned) in &record.owned {
            // A path behind a link is not followed; the record goes regardless.
            let Ok(target) = self.local_path_unchecked(path) else { continue };
            let Ok(meta) = std::fs::symlink_metadata(&target) else { continue };
            if meta.is_dir() {
                continue;
            }
            let edited = meta.is_file() && signature(&meta) != owned.local && etag_of_file(&target).is_ok_and(|etag| etag != owned.etag);
            if edited {
                let kept = exports.join(path);
                if let Some(parent) = kept.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&target, &kept).with_context(|| format!("keep the edited {path}"))?;
            }
            if std::fs::remove_file(&target).is_ok() {
                removed += 1;
            }
            self.prune_empty_parents(&target);
        }
        let _ = std::fs::remove_dir_all(self.dir.join(STAGING));
        let _ = std::fs::remove_file(self.dir.join(JOURNAL));
        std::fs::remove_file(self.dir.join(RECORD)).context("remove the mirror's record")?;
        // Gone entirely when nothing of the person's is left in it.
        let _ = std::fs::remove_dir(self.files());
        let _ = std::fs::remove_dir(&self.dir);
        Ok(removed)
    }

    /// Where `relative` lives in the mirror. Refuses a path through a
    /// symbolic link: a link planted in the mirror must never redirect a write.
    fn local_path(&self, relative: &str) -> Result<PathBuf> {
        components(relative)?;
        self.local_path_unchecked(relative)
    }

    /// [`local_path`] for a path the mirror already wrote: only that it is
    /// plain and reached through no link. Used to remove a file that today's
    /// rules would no longer accept.
    fn local_path_unchecked(&self, relative: &str) -> Result<PathBuf> {
        let parts = lexical(relative)?;
        if crate::mirror_rules::reserved(relative) {
            bail!("Git metadata is never mirrored");
        }
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

    /// What is at `relative` now. Reading needs no more than a plain path
    /// reached through no link; only writing is held to today's rules.
    fn look(&self, relative: &str) -> Result<Local> {
        let path = self.local_path_unchecked(relative)?;
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
            Local::File(_) => (etag_of_file(&self.local_path_unchecked(path)?)? != owned.etag).then_some("modified"),
        })
    }

    /// What is at `relative` now, as a discard remembers it.
    fn local_token(&self, relative: &str) -> String {
        match self.look(relative) {
            Ok(Local::File(_)) => self.local_path_unchecked(relative).ok().and_then(|path| etag_of_file(&path).ok()).unwrap_or_else(|| "unreadable".into()),
            Ok(Local::Missing) => "missing".into(),
            _ => "other".into(),
        }
    }

    /// Did the person discard exactly what is at `relative` now?
    fn discarded(&self, record: &Record, relative: &str) -> bool {
        record.discard.get(relative).is_some_and(|token| *token == self.local_token(relative))
    }

    /// Local changes to the files the mirror wrote, without asking the
    /// workspace anything.
    pub fn check(&self) -> Result<(Vec<Divergence>, usize)> {
        let record = self.working_record()?;
        let mut diverged = Vec::new();
        for (path, owned) in &record.owned {
            if self.discarded(&record, path) {
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

    /// The entries this mirror will hold, and what was refused here and why.
    /// Nothing the workspace says about itself is taken on trust: the
    /// counts, the sizes and the names are all bounded on this side.
    fn desired<'a>(&self, manifest: &'a Manifest, blocked: &BTreeSet<String>) -> Result<(BTreeMap<&'a str, &'a Entry>, Refused, bool)> {
        if manifest.truncated {
            bail!("the workspace has more files than a mirror holds");
        }
        if manifest.entries.len() > MAX_FILES {
            bail!("the workspace lists more files than a mirror holds ({MAX_FILES})");
        }
        let case = self.case_insensitive();
        let root_bytes = self.files().as_os_str().len() + 1;
        let mut refused = Refused::default();
        // Lexically sound entries, in path order. A folder is a Git
        // directory because of several of its files together, so that is
        // decided over all of them before any one is accepted.
        let mut sound: Vec<&Entry> = Vec::new();
        let mut names = BTreeSet::new();
        for entry in &manifest.entries {
            if entry.size as usize > MAX_FILE_BYTES {
                bail!("the manifest lists a file larger than a mirror holds");
            }
            if !names.insert(entry.path.as_str()) {
                bail!("the manifest names {} twice", entry.path);
            }
            if lexical(&entry.path).is_err() || crate::mirror_rules::reserved(&entry.path) {
                refused.invalid += 1;
            } else {
                sound.push(entry);
            }
        }
        sound.sort_by(|a, b| a.path.cmp(&b.path));
        let git_directories = crate::mirror_rules::git_directories(sound.iter().map(|entry| entry.path.as_str()));

        let mut desired = BTreeMap::new();
        let mut files = BTreeSet::new();
        let mut folders = BTreeSet::new();
        let mut total = 0u64;
        for entry in sound {
            let path = entry.path.as_str();
            let parts: Vec<&str> = path.split('/').collect();
            if crate::mirror_rules::secret(path) {
                refused.secret += 1;
            } else if blocked.contains(path) {
                refused.on_disk += 1;
            } else if crate::mirror_rules::inside(path, &git_directories) || crate::mirror_rules::git_pointer(path) {
                refused.git_directory += 1;
            } else if crate::mirror_rules::tool_config(path) {
                refused.tool_config += 1;
            } else if parts.len() > MAX_DEPTH || parts.iter().any(|part| part.len() > MAX_NAME_BYTES) || root_bytes + path.len() > MAX_PATH_BYTES {
                refused.too_long += 1;
            } else {
                // One name on this disk with a file already accepted, or a
                // file where an accepted entry needs a folder (or the
                // reverse): the first in path order stays.
                let key = fold(path, case);
                let parents: Vec<String> = (1..parts.len()).map(|end| fold(&parts[..end].join("/"), case)).collect();
                if files.contains(&key) || folders.contains(&key) || parents.iter().any(|parent| files.contains(parent)) {
                    refused.collision += 1;
                    continue;
                }
                total += entry.size;
                if total > MAX_TOTAL_BYTES {
                    bail!("the workspace's files are larger than a mirror holds ({} GB)", MAX_TOTAL_BYTES / (1024 * 1024 * 1024));
                }
                files.insert(key);
                folders.extend(parents);
                desired.insert(path, entry);
            }
        }
        Ok((desired, refused, case))
    }

    fn plan_with(&self, record: &Record, manifest: &Manifest) -> Result<(Plan, Vec<Divergence>, Vec<String>)> {
        let (desired, refused, case) = self.desired(manifest, &record.blocked)?;
        let forced = |path: &str| self.discarded(record, path);
        // Files of ours the workspace no longer lists, by the name this disk
        // knows them under: a rename that only changes case or Unicode form
        // leaves our own file where the new name goes, and that is not a
        // local file in the way.
        let leaving: BTreeSet<String> = record.owned.keys().filter(|path| !desired.contains_key(path.as_str())).map(|path| fold(path, case)).collect();
        let mut diverged = Vec::new();
        let mut fetch = Vec::new();
        let mut fetch_bytes = 0;
        let mut unchanged = 0;
        for (path, entry) in &desired {
            let owned = record.owned.get(*path);
            let local_change = match owned {
                Some(owned) if !forced(path) => self.divergence_of(path, owned)?,
                Some(_) => None,
                None if forced(path) || leaving.contains(&fold(path, case)) => None,
                None => match self.look(path)? {
                    Local::Missing => None,
                    _ => Some("in-the-way"),
                },
            };
            if let Some(reason) = local_change {
                diverged.push(Divergence { path: (*path).to_string(), reason });
                continue;
            }
            if owned.is_some_and(|owned| owned.version == entry.version) && !forced(path) {
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
            // A path the mirror once wrote and would refuse today (the rules
            // grew): its record is dropped, and the file is removed only if
            // it can still be reached safely.
            let reachable = self.local_path_unchecked(path).is_ok();
            match if forced(path) || !reachable { None } else { self.divergence_of(path, owned)? } {
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

    /// What a sync to `manifest` would read, remove and refuse. A new sync
    /// starts here: what an earlier one staged and never published is dropped.
    pub fn plan(&self, manifest: &Manifest) -> Result<Plan> {
        let record = self.working_record()?;
        let _ = std::fs::remove_dir_all(self.dir.join(STAGING));
        let plan = self.plan_with(&record, manifest)?.0;
        if let Some(free) = free_bytes(&self.dir) {
            if free < plan.fetch_bytes.saturating_add(FREE_DISK_FLOOR) {
                bail!("not enough free disk space for the mirror: {} MB to copy, {} MB free", plan.fetch_bytes / (1024 * 1024), free / (1024 * 1024));
            }
        }
        Ok(plan)
    }

    fn staged(&self, relative: &str, etag: &str) -> PathBuf {
        let name: String = Sha256::digest(relative.as_bytes())[..16].iter().map(|byte| format!("{byte:02x}")).collect();
        self.dir.join(STAGING).join(format!("{name}.{etag}"))
    }

    /// Keep one file read from the workspace, once its bytes are as long as
    /// the manifest said (`size`) and match the hash the workspace reported.
    /// That shows the file arrived intact, not that it can be trusted.
    /// Nothing in `files/` changes.
    pub fn stage(&self, relative: &str, bytes: &[u8], size: u64, reported_etag: &str) -> Result<()> {
        self.enabled_record()?;
        components(relative)?;
        if bytes.len() > MAX_FILE_BYTES {
            bail!("the file is larger than a mirror holds");
        }
        if bytes.len() as u64 != size {
            bail!("the file is not the size the workspace listed");
        }
        if reported_etag.len() != 32 || !reported_etag.bytes().all(|byte| byte.is_ascii_hexdigit()) || etag(bytes) != reported_etag.to_ascii_lowercase() {
            bail!("the file's content does not match its hash");
        }
        crate::store::ensure_dir(self.dir.join(STAGING))?;
        crate::store::write_atomic(&self.staged(relative, &reported_etag.to_ascii_lowercase()), bytes)
    }

    /// Put a sync in place: remove what the workspace no longer has, then
    /// every staged file by rename, then commit the record. With any
    /// divergence nothing is written. A failure part of the way records what
    /// was done, so no path is left outside the divergence check.
    pub fn publish(&self, manifest: &Manifest, etags: &BTreeMap<String, String>) -> Result<Published> {
        let mut record = self.working_record()?;
        let (plan, diverged, remove) = self.plan_with(&record, manifest)?;
        if !diverged.is_empty() {
            return Ok(Published { status: self.status_of(Some(&record)), diverged: plan.diverged, diverged_total: plan.diverged_total, written: 0, removed: 0, taken_back: 0 });
        }
        let entries: BTreeMap<&str, &Entry> = manifest.entries.iter().map(|entry| (entry.path.as_str(), entry)).collect();
        // Everything is here, the size the workspace listed and intact,
        // before the first file moves.
        let mut moves = Vec::new();
        for path in &plan.fetch {
            let entry = entries[path.as_str()];
            let etag = etags.get(path).map(|etag| etag.to_ascii_lowercase()).ok_or_else(|| anyhow!("{path} was not read"))?;
            let staged = self.staged(path, &etag);
            let meta = std::fs::symlink_metadata(&staged).map_err(|_| anyhow!("{path} was not read"))?;
            if !meta.is_file() || meta.len() != entry.size {
                bail!("{path} is not the size the workspace listed");
            }
            if etag_of_file(&staged)? != etag {
                bail!("{path} changed after it was read");
            }
            // Resolved now: a path that cannot be written fails before anything moves.
            moves.push((path.clone(), staged, etag, self.local_path(path)?));
        }
        let journal = Journal {
            manifest_id: manifest.manifest_id.clone(),
            writes: moves.iter().map(|(path, _, etag, _)| (path.clone(), Write { etag: etag.clone(), version: entries[path.as_str()].version.clone() })).collect(),
            deletes: remove.iter().cloned().collect(),
        };
        crate::store::write_json(&self.dir.join(JOURNAL), &journal)?;

        let mut removed = 0;
        let mut written = 0;
        let applied = (|| -> Result<()> {
            // Removals first: a rename that only changes case would
            // otherwise delete the file just written under the new name.
            for path in &remove {
                if let Ok(target) = self.local_path_unchecked(path) {
                    match std::fs::symlink_metadata(&target) {
                        Ok(meta) if meta.is_dir() => bail!("a local folder is in the way at {path}; move it, then sync again"),
                        Ok(_) => std::fs::remove_file(&target).with_context(|| format!("remove {path}"))?,
                        Err(_) => {}
                    }
                    self.prune_empty_parents(&target);
                }
                record.owned.remove(path);
                removed += 1;
            }
            for (path, staged, etag, target) in &moves {
                let entry = entries[path.as_str()];
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).with_context(|| format!("create the folder of {path}"))?;
                }
                // A folder where a file belongs is never removed for it.
                if std::fs::symlink_metadata(target).is_ok_and(|meta| meta.is_dir()) {
                    bail!("a local folder is in the way at {path}; move it, then sync again");
                }
                seal(staged)?;
                std::fs::rename(staged, target).with_context(|| format!("put {path} in place"))?;
                let meta = std::fs::symlink_metadata(target)?;
                record.owned.insert(path.clone(), Owned { version: entry.version.clone(), etag: etag.clone(), size: meta.len(), local: signature(&meta) });
                written += 1;
            }
            Ok(())
        })();
        if let Err(error) = applied {
            // Some files did land before the failure: the disk is judged
            // for those too, so nothing a mirror never holds stays behind
            // because the publish it came in did not finish.
            if let Err(audit) = self.audit(&mut record) {
                log::warn!("check the mirror after a failed publish: {audit:#}");
            }
            // What did move is recorded as moved, and the journal goes: the
            // next sync sees every path as it is, with nothing exempt.
            self.save(&record)?;
            let _ = std::fs::remove_file(self.dir.join(JOURNAL));
            return Err(error);
        }
        // The names were judged by what this code knows of the disk. Now the
        // disk has them: look at what is really there.
        let taken_back = match self.audit(&mut record) {
            Ok(taken_back) => taken_back,
            Err(error) => {
                self.save(&record)?;
                let _ = std::fs::remove_file(self.dir.join(JOURNAL));
                return Err(error);
            }
        };
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
        Ok(Published { status: self.status_of(Some(&record)), diverged: Vec::new(), diverged_total: 0, written, removed, taken_back })
    }

    /// Every file and folder really under `files/`, by the names the disk
    /// gives them, relative and `/`-separated. A folder is listed as
    /// `<folder>/.`, so an empty `objects/` still counts. Links are listed,
    /// never followed.
    fn on_disk(&self) -> Result<Vec<String>> {
        let root = self.files();
        let mut found = Vec::new();
        let mut frontier = vec![(root.clone(), 0usize)];
        while let Some((dir, depth)) = frontier.pop() {
            for entry in std::fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))? {
                let entry = entry?;
                let path = entry.path();
                let relative = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
                if entry.file_type()?.is_dir() {
                    found.push(format!("{relative}/."));
                    if depth < MAX_DEPTH + 1 {
                        frontier.push((path, depth + 1));
                    }
                } else {
                    found.push(relative);
                }
            }
        }
        Ok(found)
    }

    /// The disk's own spelling of a file the mirror wrote: the folder it
    /// landed in may be an existing one under another case or Unicode form.
    fn real_relative(&self, relative: &str) -> Option<String> {
        let real = std::fs::canonicalize(self.local_path_unchecked(relative).ok()?).ok()?;
        let root = std::fs::canonicalize(self.files()).ok()?;
        Some(real.strip_prefix(&root).ok()?.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"))
    }

    /// After the files are in place, judge them again by what the disk
    /// really holds, with the disk's own idea of which names are one folder.
    /// Whatever the mirror wrote that is, there, part of a Git directory, a
    /// pointer to one, tool configuration or a secret is removed and never
    /// written again. Only the mirror's own files are removed. Returns how
    /// many.
    fn audit(&self, record: &mut Record) -> Result<usize> {
        let real = self.on_disk()?;
        let git_directories = crate::mirror_rules::git_directories(real.iter().map(String::as_str));
        let mut taken_back = Vec::new();
        for path in record.owned.keys() {
            let Some(spelled) = self.real_relative(path) else { continue };
            let refused = crate::mirror_rules::inside(&spelled, &git_directories)
                || crate::mirror_rules::git_pointer(&spelled)
                || crate::mirror_rules::tool_config(&spelled)
                || crate::mirror_rules::secret(&spelled)
                || crate::mirror_rules::reserved(&spelled);
            if refused {
                taken_back.push(path.clone());
            }
        }
        for path in &taken_back {
            let target = self.local_path_unchecked(path)?;
            if std::fs::symlink_metadata(&target).is_ok_and(|meta| !meta.is_dir()) {
                std::fs::remove_file(&target).with_context(|| format!("remove {path}"))?;
            }
            self.prune_empty_parents(&target);
            record.owned.remove(path);
            record.blocked.insert(path.clone());
        }
        Ok(taken_back.len())
    }

    /// Remove folders the last removal left empty, up to `files/`.
    fn prune_empty_parents(&self, target: &Path) {
        let root = self.files();
        let mut dir = target.parent();
        while let Some(current) = dir.filter(|current| *current != root && current.starts_with(&root)) {
            // Finder's own bookkeeping is not content: a folder holding
            // nothing else is empty, and must not outlive its files.
            let only_finder = std::fs::read_dir(current).is_ok_and(|entries| entries.filter_map(Result::ok).all(|entry| entry.file_name() == ".DS_Store"));
            if only_finder {
                let _ = std::fs::remove_file(current.join(".DS_Store"));
            }
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
        let mut record = self.working_record()?;
        let (_, diverged, _) = self.plan_with(&record, manifest)?;
        for item in &diverged {
            // A local folder is never discarded for a file.
            if std::fs::symlink_metadata(self.local_path(&item.path)?).is_ok_and(|meta| meta.is_dir()) {
                bail!("a local folder is in the way at {}; move it, then sync again", item.path);
            }
        }
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
            record.discard.insert(item.path.clone(), self.local_token(&item.path));
        }
        self.save(&record)?;
        Ok(Resolved { paths: diverged.len(), exported_to })
    }
}

/// Every mirror on this computer, as `(organization id, workspace id)`.
/// Linked directories are not looked into.
pub fn existing(home: &Path) -> Vec<(String, String)> {
    let real_dirs = |dir: &Path| -> Vec<(String, PathBuf)> {
        let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
        entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
            .filter(|(name, _)| valid_id(name))
            .collect()
    };
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let mirrors = home.join(DIR);
    if std::fs::symlink_metadata(&mirrors).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Vec::new();
    }
    let mut found = Vec::new();
    for (organization, dir) in real_dirs(&mirrors) {
        for (workspace, dir) in real_dirs(&dir) {
            if dir.join(RECORD).is_file() {
                found.push((organization.clone(), workspace));
            }
        }
    }
    found.sort();
    found
}

const OWNER: &str = "owner";

fn owner_hash(account: &str) -> String {
    Sha256::digest(account.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The owner file's content for an account id. The prefix tells it from a
/// file written before the id was used, which holds a bare hash of the email.
fn owner_record(account: &str) -> String {
    format!("{OWNER_V2}{}", owner_hash(account))
}

const OWNER_V2: &str = "v2:";
/// A bare (email-keyed) owner file is honoured for this long after it was
/// written, then it is nobody's: the window in which presenting an email
/// can claim a mirror has an end.
const LEGACY_OWNER_WINDOW: std::time::Duration = std::time::Duration::from_secs(14 * 24 * 60 * 60);
const UNREADABLE: &str = "unreadable.json";
/// How long mirrors are kept while the saved session cannot be read: until
/// the third launch that finds it so, or a day after the first, whichever
/// comes first. Then they are removed, as at a sign-out.
pub const UNREADABLE_LAUNCHES: u32 = 3;
pub const UNREADABLE_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Unreadable {
    first_at_ms: u64,
    launches: u32,
}

/// Say which account is using the app. Mirrors that are not this account's
/// are removed, as at sign-out: ones made under another account (a sign-out
/// while the app was closed, a direct switch of account), and ones found
/// with no owner recorded at all, which nobody here can vouch for. Returns
/// how many mirrors were removed. The owner is kept as a hash.
///
/// `account` is the account's own id (the user and cloud profile), which
/// does not change with the address. `legacy` is what an owner file written
/// before that was keyed on, the email: a file that still holds it for the
/// same person, and is not older than [`LEGACY_OWNER_WINDOW`], is rewritten
/// to the id, and their mirrors are kept.
pub fn claim_owner(home: &Path, account: &str, legacy: Option<&str>) -> Result<usize> {
    claim_owner_at(home, account, legacy, std::time::SystemTime::now())
}

fn claim_owner_at(home: &Path, account: &str, legacy: Option<&str>, now: std::time::SystemTime) -> Result<usize> {
    let mirrors = existing(home);
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let file = home.join(DIR).join(OWNER);
    let wanted = owner_record(account);
    let known = std::fs::read_to_string(&file).ok();
    // Someone is known to be signed in: the session is readable again.
    let _ = std::fs::remove_file(home.join(DIR).join(UNREADABLE));
    if known.as_deref() == Some(wanted.as_str()) {
        return Ok(0);
    }
    let recent = std::fs::metadata(&file).and_then(|meta| meta.modified()).is_ok_and(|written| now.duration_since(written).is_ok_and(|age| age <= LEGACY_OWNER_WINDOW));
    if recent && legacy.is_some_and(|email| !email.is_empty() && known.as_deref() == Some(owner_hash(email).as_str())) {
        crate::store::write_atomic(&file, wanted.as_bytes())?;
        return Ok(0);
    }
    let mut purged = 0;
    for (organization, workspace) in &mirrors {
        Mirror::at(&home, organization, workspace)?.purge()?;
        purged += 1;
    }
    // Nothing is created for someone who has no mirror: `enable_as` writes
    // the owner with the first one.
    if known.is_some() {
        crate::store::write_atomic(&file, wanted.as_bytes())?;
    }
    Ok(purged)
}

/// The app started and could not read its saved session, so it does not
/// know who is signed in. That is not a sign-out, and the mirrors are kept;
/// but not for ever, because access may have been revoked meanwhile and the
/// app cannot find out. Counted once per launch: on the
/// [`UNREADABLE_LAUNCHES`]th launch in that state, or [`UNREADABLE_MS`] after
/// the first, every mirror is removed. Returns how many were.
pub fn note_unreadable(home: &Path, now_ms: u64) -> Result<usize> {
    let mirrors = existing(home);
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let file = home.join(DIR).join(UNREADABLE);
    if mirrors.is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(0);
    }
    let mut mark: Unreadable = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Unreadable { first_at_ms: now_ms, launches: 0 });
    mark.launches = mark.launches.saturating_add(1);
    if mark.launches < UNREADABLE_LAUNCHES && now_ms.saturating_sub(mark.first_at_ms) < UNREADABLE_MS {
        crate::store::write_json(&file, &mark)?;
        return Ok(0);
    }
    let mut purged = 0;
    for (organization, workspace) in &mirrors {
        Mirror::at(&home, organization, workspace)?.purge()?;
        purged += 1;
    }
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_file(home.join(DIR).join(OWNER));
    Ok(purged)
}

/// Is `path` inside the directory that holds every mirror? A mirror is for
/// reading: it is never a project or an agent's working directory.
pub fn holds(home: &Path, path: &Path) -> bool {
    let mirrors = std::fs::canonicalize(home.join(DIR)).unwrap_or_else(|_| home.join(DIR));
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path.starts_with(mirrors)
}

/// Make a staged file what every mirrored file is: readable, never
/// executable, and on macOS quarantined, so opening it from Finder goes
/// through Gatekeeper like any download.
fn seal(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).context("set the file's mode")?;
    }
    quarantine(path)
}

#[cfg(target_os = "macos")]
const QUARANTINE: &str = "com.apple.quarantine";

#[cfg(target_os = "macos")]
fn quarantine(path: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let file = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let name = std::ffi::CString::new(QUARANTINE)?;
    // The format Launch Services writes: flags (0081: downloaded, not yet
    // approved), the time in hex, the agent's name.
    let value = format!("0081;{:x};TerminalX;", now_ms() / 1000);
    // SAFETY: both strings are NUL-terminated and `value` is valid for its length.
    let result = unsafe { libc::setxattr(file.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, libc::XATTR_NOFOLLOW) };
    if result != 0 {
        return Err(std::io::Error::last_os_error()).context("quarantine the mirrored file");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn quarantine(_path: &Path) -> Result<()> {
    Ok(())
}

/// Bytes an unprivileged process may still write on the disk holding `path`.
#[cfg(unix)]
fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is a valid C string and `stats` is writable for one
    // `statvfs`; it is read only after the call reports success.
    let stats = unsafe {
        if libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) != 0 {
            return None;
        }
        stats.assume_init()
    };
    #[allow(clippy::unnecessary_cast)]
    Some((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

#[cfg(not(unix))]
fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
#[path = "cloud_mirror_tests.rs"]
mod tests;
