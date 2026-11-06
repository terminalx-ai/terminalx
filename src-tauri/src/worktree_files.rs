//! Repository copy preferences are a local layer; `.worktreeinclude` replaces
//! that layer, including when empty. Only Git-ignored, untracked files qualify.

use std::collections::{BTreeSet, VecDeque};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};

use crate::{git, store::projects};

const MAX_PATTERNS: usize = 128;
const MAX_INCLUDE_BYTES: u64 = 64 * 1024;
const MAX_SCAN_FILES: usize = 20_000;
const MAX_SCAN_BYTES: usize = 4 * 1024 * 1024;
const MAX_PREVIEW_MATCHES: usize = 100;
const MAX_COPY_FILES: usize = 1_000;
const MAX_COPY_BYTES: u64 = 100 * 1024 * 1024;
const MAX_REPORT_DETAILS: usize = 100;
const SCAN_WARNING: &str = "Ignored-file scan limit reached (20,000 files or 4 MiB of paths). Additional files were not inspected or copied.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub root_path: String,
    pub workspaces_path: String,
    pub from_include_file: bool,
    pub patterns: Vec<PatternPreview>,
    pub error: Option<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternPreview {
    pub pattern: String,
    pub matches: Vec<String>,
    pub omitted: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CopyReport {
    pub copied_count: usize,
    pub copied_bytes: u64,
    pub skipped_count: usize,
    pub warnings: Vec<SkippedFile>,
    pub skipped: Vec<SkippedFile>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

impl CopyReport {
    fn skip(&mut self, path: String, reason: impl Into<String>) {
        self.skipped_count += 1;
        if self.skipped.len() < MAX_REPORT_DETAILS { self.skipped.push(SkippedFile { path, reason: reason.into() }); }
    }
}

#[derive(Debug, Default)]
struct IgnoredFiles { files: Vec<String>, limited: bool }

struct CachedScan { project: PathBuf, token: String, scan: Arc<IgnoredFiles> }
#[derive(Default)]
struct PreviewCache { entries: VecDeque<CachedScan> }

impl PreviewCache {
    fn get(&mut self, project: &Path, token: &str, scan: impl FnOnce() -> Result<IgnoredFiles>) -> Result<Arc<IgnoredFiles>> {
        if let Some(entry) = self.entries.iter().find(|entry| entry.project == project && entry.token == token) {
            return Ok(entry.scan.clone());
        }
        let scan = Arc::new(scan()?);
        // At most four bounded snapshots, independent of the number of windows.
        if self.entries.len() == 4 { self.entries.pop_front(); }
        self.entries.push_back(CachedScan { project: project.to_path_buf(), token: token.into(), scan: scan.clone() });
        Ok(scan)
    }
}

fn ignored_snapshot(project: &Path, token: Option<&str>) -> Result<Arc<IgnoredFiles>> {
    let Some(token) = token else { return ignored_files(project).map(Arc::new) };
    anyhow::ensure!(!token.is_empty() && token.len() <= 64, "Invalid preview snapshot");
    static CACHE: OnceLock<Mutex<PreviewCache>> = OnceLock::new();
    CACHE.get_or_init(Default::default).lock().unwrap_or_else(|error| error.into_inner())
        .get(project, token, || ignored_files(project))
}

pub fn has_include_file(project: &Path) -> Result<bool> {
    match fs::symlink_metadata(project.join(".worktreeinclude")) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn effective_patterns(project: &Path, draft: Option<&[String]>) -> Result<(bool, Vec<String>)> {
    if has_include_file(project)? {
        // Do not follow a repository-supplied link to a file elsewhere on the Mac.
        let mut file = safe_open::read(project, Path::new(".worktreeinclude")).context("Could not read .worktreeinclude")?;
        let mut text = String::new();
        (&mut file).take(MAX_INCLUDE_BYTES + 1).read_to_string(&mut text)?;
        anyhow::ensure!(text.len() as u64 <= MAX_INCLUDE_BYTES, ".worktreeinclude is too large (maximum 64 KiB)");
        let patterns = text.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).map(String::from).collect();
        return Ok((true, patterns));
    }
    Ok((false, match draft {
        Some(patterns) => patterns.to_vec(),
        None => projects::repository_settings(project)?.files_to_copy,
    }))
}

fn matcher(pattern: &str) -> Result<GlobMatcher> {
    anyhow::ensure!(!pattern.is_empty() && pattern.len() <= 1024, "Use a glob of 1–1024 bytes");
    anyhow::ensure!(!pattern.starts_with('!'), "Negation is not supported; use positive repository-relative globs");
    anyhow::ensure!(!pattern.starts_with('/') && !pattern.contains('\\') && !pattern.contains(':')
        && !pattern.split('/').any(|part| matches!(part, ".." | ".") || part.eq_ignore_ascii_case(".git")),
        "Use a path relative to the repository, without .. or .git");
    Ok(GlobBuilder::new(pattern).literal_separator(true).build()?.compile_matcher())
}

pub fn validate_patterns(patterns: &[String]) -> Result<()> {
    anyhow::ensure!(patterns.len() <= MAX_PATTERNS, "Use at most {MAX_PATTERNS} patterns");
    for pattern in patterns { matcher(pattern).with_context(|| format!("Invalid pattern {pattern:?}"))?; }
    Ok(())
}

fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|part| match part {
        Component::Normal(name) => !name.to_string_lossy().eq_ignore_ascii_case(".git"),
        _ => false,
    })
}

fn ignored_files(project: &Path) -> Result<IgnoredFiles> {
    let workspaces = git::worktree_root(project);
    let mut args = vec!["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "."];
    // Exclude managed worktrees before Git walks them: a broad glob must not
    // recursively copy old workspaces (or the workspace just being created).
    let excluded = workspaces.strip_prefix(project).ok().map(|path| format!(":(exclude,literal){}", path.display()));
    if let Some(excluded) = &excluded { args.push(excluded); }
    let (files, limited) = git::file_names_bounded(project, &args, MAX_SCAN_FILES, MAX_SCAN_BYTES)?;
    let files = files.into_iter().filter(|file| {
        let path = Path::new(file);
        safe_relative(path) && !project.join(path).starts_with(&workspaces)
            && !fs::symlink_metadata(project.join(path)).is_ok_and(|metadata| metadata.is_dir())
    }).collect::<BTreeSet<_>>().into_iter().collect();
    Ok(IgnoredFiles { files, limited })
}

pub fn preview(project: &Path, draft: Option<&[String]>, snapshot: Option<&str>) -> Result<Preview> {
    let project = fs::canonicalize(project)?;
    anyhow::ensure!(git::is_own_worktree(&project), "Choose the root of a Git repository");
    let mut preview = Preview {
        root_path: project.to_string_lossy().into_owned(),
        workspaces_path: git::worktree_root(&project).to_string_lossy().into_owned(),
        from_include_file: has_include_file(&project)?,
        patterns: Vec::new(), error: None, warning: None,
    };
    // Path rows and the repository-file lock remain available even when the
    // file is unreadable or its list exceeds the limit.
    let result = (|| -> Result<()> {
        let (from_include_file, patterns) = effective_patterns(&project, draft)?;
        preview.from_include_file = from_include_file;
        anyhow::ensure!(patterns.len() <= MAX_PATTERNS, "Use at most {MAX_PATTERNS} patterns");
        // An empty pattern list needs only the paths, with no filesystem scan.
        let ignored = if patterns.is_empty() { Arc::new(IgnoredFiles::default()) } else { ignored_snapshot(&project, snapshot)? };
        if ignored.limited { preview.warning = Some(SCAN_WARNING.into()); }
        preview.patterns = patterns.into_iter().map(|pattern| {
            match matcher(&pattern) {
                Ok(glob) => {
                    let matches: Vec<_> = ignored.files.iter().filter(|file| glob.is_match(file)).collect();
                    PatternPreview { omitted: matches.len().saturating_sub(MAX_PREVIEW_MATCHES),
                        matches: matches.into_iter().take(MAX_PREVIEW_MATCHES).cloned().collect(), pattern, error: None }
                },
                Err(error) => PatternPreview { pattern, matches: Vec::new(), omitted: 0, error: Some(error.to_string()) },
            }
        }).collect();
        Ok(())
    })();
    if let Err(error) = result { preview.error = Some(format!("{error:#}")); }
    Ok(preview)
}

/// A failed copy must not hide a successfully created worktree. Report the
/// outcome to all session clients, and continue with the checkout intact.
pub fn copy_on_create(project: &Path, destination: &Path) -> Option<CopyReport> {
    let report = match copy_files(project, destination) {
        Ok(report) => report,
        Err(error) => CopyReport { error: Some(format!("Could not copy workspace files: {error:#}")), ..Default::default() },
    };
    (report.copied_count > 0 || report.skipped_count > 0 || !report.warnings.is_empty() || report.error.is_some()).then_some(report)
}

fn copy_files(project: &Path, destination: &Path) -> Result<CopyReport> {
    copy_files_with_limits(project, destination, MAX_COPY_FILES, MAX_COPY_BYTES)
}

fn copy_files_with_limits(project: &Path, destination: &Path, max_files: usize, max_bytes: u64) -> Result<CopyReport> {
    let project = fs::canonicalize(project)?;
    anyhow::ensure!(git::is_own_worktree(&project), "Choose the root of a Git repository");
    let (_, patterns) = effective_patterns(&project, None)?;
    anyhow::ensure!(patterns.len() <= MAX_PATTERNS, "Use at most {MAX_PATTERNS} patterns");
    let mut report = CopyReport::default();
    if patterns.is_empty() { return Ok(report); }
    // Creation always scans afresh; preview snapshots can never authorize a copy.
    let ignored = ignored_files(&project)?;
    if ignored.limited { report.error = Some(SCAN_WARNING.into()); }
    let mut files = BTreeSet::new();
    for pattern in patterns {
        match matcher(&pattern) {
            Ok(glob) => files.extend(ignored.files.iter().filter(|file| glob.is_match(file)).cloned()),
            Err(error) => report.skip(pattern, format!("Invalid pattern: {error}")),
        }
    }
    let files: Vec<_> = files.into_iter().collect();
    let eligible = if files.is_empty() { BTreeSet::new() } else {
        git::ignored_untracked_paths(destination, &files[..files.len().min(max_files)])?
    };
    for (index, path) in files.into_iter().enumerate() {
        if index >= max_files {
            report.skip(path, format!("Copy limit: at most {max_files} matching files per workspace"));
            continue;
        }
        if !eligible.contains(&path) {
            report.skip(path, "Tracked or not ignored in the new workspace");
            continue;
        }
        match copy_one(&project, destination, Path::new(&path), max_bytes - report.copied_bytes) {
            Ok((bytes, warning)) => {
                report.copied_count += 1;
                report.copied_bytes += bytes;
                if let Some(reason) = warning {
                    if report.warnings.len() < MAX_REPORT_DETAILS { report.warnings.push(SkippedFile { path, reason }); }
                }
            }
            Err(error) => report.skip(path, format!("{error:#}")),
        }
    }
    Ok(report)
}

fn copy_one(project: &Path, destination: &Path, relative: &Path, remaining_bytes: u64) -> Result<(u64, Option<String>)> {
    anyhow::ensure!(safe_relative(relative), "Unsafe relative path");
    let mut source = safe_open::read(project, relative)?;
    anyhow::ensure!(source.metadata()?.len() <= remaining_bytes, "Workspace copy byte limit reached");
    safe_open::copy(&mut source, destination, relative, remaining_bytes)
}

fn copy_bounded(source: &mut impl Read, target: &mut File, remaining_bytes: u64) -> Result<u64> {
    let bytes = std::io::copy(&mut source.take(remaining_bytes + 1), target)?;
    anyhow::ensure!(bytes <= remaining_bytes, "Workspace copy byte limit reached");
    Ok(bytes)
}

/// A published file remains copied even if removing its temporary link fails.
/// Preserve the primary error on failed publication, with cleanup noted separately.
fn finish_publication(result: Result<()>, cleanup: std::io::Result<()>) -> Result<Option<String>> {
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(None),
        (Ok(()), Err(error)) => Ok(Some(format!("Copied, but could not remove temporary file: {error}"))),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(error.context(format!("Could not remove temporary file: {cleanup}"))),
    }
}

/// Open each component relative to a held directory, without following links.
/// This also protects against parent-directory replacements during a copy.
#[cfg(unix)]
mod safe_open {
    use super::*;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;

    fn parent(root: &Path, relative: &Path, create: bool) -> Result<(File, CString)> {
        anyhow::ensure!(safe_relative(relative), "Unsafe relative path");
        let mut directory = fs::OpenOptions::new().read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(root)?;
        let parts: Vec<_> = relative.components().collect();
        for part in &parts[..parts.len() - 1] {
            let name = CString::new(part.as_os_str().as_bytes())?;
            if create {
                // SAFETY: directory is a live fd; name is a NUL-terminated component.
                let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                if result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
            directory = open_at(&directory, &name, libc::O_RDONLY | libc::O_DIRECTORY)?;
        }
        Ok((directory, CString::new(relative.file_name().context("Missing file name")?.as_bytes())?))
    }

    fn open_at(directory: &File, name: &CString, flags: i32) -> Result<File> {
        // SAFETY: live directory fd and valid component; mode is used only for O_CREAT.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
        if fd < 0 { return Err(std::io::Error::last_os_error().into()); }
        // SAFETY: openat returned a new fd, now owned by File.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(super) fn read(root: &Path, relative: &Path) -> Result<File> {
        let (directory, name) = parent(root, relative, false)?;
        let file = open_at(&directory, &name, libc::O_RDONLY | libc::O_NONBLOCK)?;
        anyhow::ensure!(file.metadata()?.is_file(), "Only regular files can be copied");
        Ok(file)
    }

    pub(super) fn copy(source: &mut File, root: &Path, relative: &Path, remaining_bytes: u64) -> Result<(u64, Option<String>)> {
        use std::os::unix::fs::PermissionsExt;
        let mut bytes = 0;
        let warning = write_atomic(root, relative, |target| {
            bytes = copy_bounded(source, target, remaining_bytes)?;
            // Keep executable local scripts usable, without broadening access to secrets.
            target.set_permissions(fs::Permissions::from_mode(0o600 | (source.metadata()?.permissions().mode() & 0o100)))?;
            Ok(())
        })?;
        Ok((bytes, warning))
    }

    pub(super) fn write_atomic(root: &Path, relative: &Path, write: impl FnOnce(&mut File) -> Result<()>) -> Result<Option<String>> {
        let (directory, name) = parent(root, relative, true)?;
        let temporary = CString::new(format!(".terminalx-copy-{}", uuid::Uuid::new_v4()))?;
        let mut target = open_at(&directory, &temporary, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
        let result = write(&mut target).and_then(|()| {
            // Publish only the complete file. linkat fails if anything already
            // occupies the destination, including a dangling symbolic link.
            // SAFETY: both names and the held directory fd remain valid.
            let linked = unsafe { libc::linkat(directory.as_raw_fd(), temporary.as_ptr(), directory.as_raw_fd(), name.as_ptr(), 0) };
            if linked < 0 { return Err(std::io::Error::last_os_error().into()); }
            Ok(())
        });
        // SAFETY: remove the temporary entry in the same held directory.
        let removed = unsafe { libc::unlinkat(directory.as_raw_fd(), temporary.as_ptr(), 0) };
        finish_publication(result, if removed < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) })
    }

}

#[cfg(not(unix))]
mod safe_open {
    use super::*;
    // Best effort on non-Unix platforms: reject symlinks and junctions in
    // every component, but path-based opens cannot prevent replacements
    // between this check and use. Unlike the Unix fd traversal, this is not
    // a boundary against concurrent filesystem changes by another process.
    fn checked(root: &Path, relative: &Path, create: bool) -> Result<std::path::PathBuf> {
        anyhow::ensure!(safe_relative(relative), "Unsafe relative path");
        let mut path = fs::canonicalize(root)?;
        let count = relative.components().count();
        for (index, component) in relative.components().enumerate() {
            path.push(component);
            if index + 1 == count && create { break; }
            if create && !path.exists() { fs::create_dir(&path)?; }
            let metadata = fs::symlink_metadata(&path)?;
            anyhow::ensure!(!metadata.file_type().is_symlink(), "Symbolic links are not copied");
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                anyhow::ensure!(metadata.file_attributes() & 0x400 == 0, "Reparse points are not copied");
            }
        }
        Ok(path)
    }
    pub(super) fn read(root: &Path, relative: &Path) -> Result<File> {
        let file = File::open(checked(root, relative, false)?)?;
        anyhow::ensure!(file.metadata()?.is_file(), "Only regular files can be copied");
        Ok(file)
    }
    pub(super) fn copy(source: &mut File, root: &Path, relative: &Path, remaining_bytes: u64) -> Result<(u64, Option<String>)> {
        let destination = checked(root, relative, true)?;
        let temporary = destination.with_file_name(format!(".terminalx-copy-{}", uuid::Uuid::new_v4()));
        let mut target = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        let mut bytes = 0;
        let result = copy_bounded(source, &mut target, remaining_bytes).and_then(|copied| {
            bytes = copied;
            fs::hard_link(&temporary, &destination).map_err(Into::into)
        });
        drop(target);
        let warning = finish_publication(result, fs::remove_file(temporary))?;
        Ok((bytes, warning))
    }
}

#[cfg(test)]
#[path = "worktree_files_tests.rs"]
mod tests;
