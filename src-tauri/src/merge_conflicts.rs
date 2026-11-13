//! One conflicted file of a merge in progress, cut into its conflicts, and
//! resolved one conflict at a time (PRO-293).
//!
//! The file is read from disk as bytes and cut where Git's conflict markers
//! are: `<<<<<<<`, an optional `|||||||` base section (diff3 and zdiff3),
//! `=======` and `>>>>>>>`, each at the start of a line and followed by a
//! space or the line's end. The markers are seven characters long unless the
//! path's `conflict-marker-size` attribute says otherwise. A block that does
//! not close, or whose markers come out of order, is ordinary text.
//!
//! Every read carries `version`, the SHA-256 of the bytes read. A resolve or
//! a mark is refused when the file no longer hashes to it, so a choice made
//! on what the file used to say is never written over what it says now.
//!
//! A resolve rewrites only the bytes of the chosen conflict; everything else,
//! line endings included, stays as it was. The file is written to a temporary
//! file beside it, with its permissions, and renamed over it.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::ops::Range;
use std::path::{Component, Path};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::git;
use crate::unfinished_merge;

/// The marker length Git uses when no attribute changes it.
const DEFAULT_MARKER_SIZE: usize = 7;

/// The last commit on one side, since the merge base, that changed the file.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SideCommit {
    pub id: String,
    pub subject: String,
    pub author: String,
    /// Commit time, Unix seconds.
    pub time: i64,
    /// The pull request the subject names; `None` when it names none.
    pub pr: Option<u64>,
}

/// Where one side of the file's text came from.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    /// This checkout's branch for ours; what is being merged for theirs.
    pub branch: String,
    pub commit: Option<SideCommit>,
}

/// One `<<<<<<<` … `>>>>>>>` block, as it is on disk.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictHunk {
    /// Its place among the file's conflicts, from 0.
    pub index: usize,
    /// 1-based line of its `<<<<<<<` marker.
    pub line: usize,
    pub ours: String,
    pub theirs: String,
    /// The common ancestor's text, for diff3 and zdiff3 markers.
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConflictSegment {
    Text { text: String },
    Conflict { hunk: ConflictHunk },
}

/// A conflicted file of the merge in progress, as read from disk.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// Lowercase hex SHA-256 of the bytes read.
    pub version: String,
    pub segments: Vec<ConflictSegment>,
    /// How many conflicts `segments` holds.
    pub conflicts: usize,
    pub ours: ConflictSide,
    pub theirs: ConflictSide,
    /// Why the file cannot be resolved conflict by conflict; `None` when it can.
    pub unsupported: Option<String>,
}

/// Which side a conflict is replaced with.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictChoice {
    Ours,
    Theirs,
    /// Ours, then theirs.
    Both,
}

// ---- parsing

/// Where one conflict block lies in the file's bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Block {
    /// The whole block, markers included.
    whole: Range<usize>,
    /// 1-based line of the `<<<<<<<` marker.
    line: usize,
    ours: Range<usize>,
    base: Option<Range<usize>>,
    theirs: Range<usize>,
}

/// The file's lines as byte ranges, each with its line ending; the last one
/// may have none.
fn lines(bytes: &[u8]) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (at, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            out.push(start..at + 1);
            start = at + 1;
        }
    }
    if start < bytes.len() {
        out.push(start..bytes.len());
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Marker {
    Open,
    Base,
    Split,
    Close,
}

/// The marker a line starts with: exactly `size` of the marker character,
/// then a space or the line's end.
fn marker(line: &[u8], size: usize) -> Option<Marker> {
    let kind = match line.first()? {
        b'<' => Marker::Open,
        b'|' => Marker::Base,
        b'=' => Marker::Split,
        b'>' => Marker::Close,
        _ => return None,
    };
    if line.len() < size || line[..size].iter().any(|byte| *byte != line[0]) {
        return None;
    }
    match &line[size..] {
        [] | [b'\n'] | [b'\r', b'\n'] | [b'\r'] | [b' ', ..] => Some(kind),
        _ => None,
    }
}

/// The well-formed conflict blocks in the file, in order. A block that does
/// not close, or whose markers come out of order, is not one; reading goes on
/// from the line after its `<<<<<<<`.
fn blocks(bytes: &[u8], size: usize) -> Vec<Block> {
    let lines = lines(bytes);
    let kinds: Vec<Option<Marker>> = lines.iter().map(|range| marker(&bytes[range.clone()], size)).collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        if kinds[at] != Some(Marker::Open) {
            at += 1;
            continue;
        }
        match block_from(&lines, &kinds, at) {
            Some((block, next)) => {
                out.push(block);
                at = next;
            }
            None => at += 1,
        }
    }
    out
}

/// The block whose `<<<<<<<` is line `open`, and the line after it.
fn block_from(lines: &[Range<usize>], kinds: &[Option<Marker>], open: usize) -> Option<(Block, usize)> {
    // The lines `from..to`; `to` is always a marker line, so an empty
    // section is the empty range where that marker starts.
    let between = |from: usize, to: usize| if from < to { lines[from].start..lines[to - 1].end } else { lines[to].start..lines[to].start };
    let mut at = open + 1;
    // Ours, up to `|||||||` or `=======`.
    while at < lines.len() && kinds[at].is_none() {
        at += 1;
    }
    let ours_end = at;
    let mut base = None;
    match kinds.get(at).copied().flatten()? {
        Marker::Split => {}
        Marker::Base => {
            at += 1;
            while at < lines.len() && kinds[at].is_none() {
                at += 1;
            }
            if kinds.get(at).copied().flatten()? != Marker::Split {
                return None;
            }
            base = Some(between(ours_end + 1, at));
        }
        Marker::Open | Marker::Close => return None,
    }
    let split = at;
    at += 1;
    while at < lines.len() && kinds[at].is_none() {
        at += 1;
    }
    if kinds.get(at).copied().flatten()? != Marker::Close {
        return None;
    }
    let close = at;
    let block = Block {
        whole: lines[open].start..lines[close].end,
        line: open + 1,
        ours: between(open + 1, ours_end),
        base,
        theirs: between(split + 1, close),
    };
    Some((block, close + 1))
}

/// The file cut into the text outside conflicts and the conflicts.
fn segments(bytes: &[u8], blocks: &[Block]) -> Vec<ConflictSegment> {
    let text = |range: Range<usize>| String::from_utf8_lossy(&bytes[range]).into_owned();
    let mut out = Vec::new();
    let mut at = 0;
    for (index, block) in blocks.iter().enumerate() {
        if at < block.whole.start {
            out.push(ConflictSegment::Text { text: text(at..block.whole.start) });
        }
        out.push(ConflictSegment::Conflict {
            hunk: ConflictHunk { index, line: block.line, ours: text(block.ours.clone()), theirs: text(block.theirs.clone()), base: block.base.clone().map(text) },
        });
        at = block.whole.end;
    }
    if at < bytes.len() {
        out.push(ConflictSegment::Text { text: text(at..bytes.len()) });
    }
    out
}

/// The line ending the file uses: that of its first line, `\n` when it has
/// none.
fn line_ending(bytes: &[u8]) -> &'static [u8] {
    match bytes.iter().position(|byte| *byte == b'\n') {
        Some(at) if at > 0 && bytes[at - 1] == b'\r' => b"\r\n",
        _ => b"\n",
    }
}

/// The file with conflict `index` replaced by the chosen side; `None` when
/// it has no such conflict.
fn resolved(bytes: &[u8], size: usize, index: usize, choice: ConflictChoice) -> Option<Vec<u8>> {
    blocks(bytes, size).get(index).map(|block| splice(bytes, block, choice))
}

/// The file with `block` replaced by the chosen side.
fn splice(bytes: &[u8], block: &Block, choice: ConflictChoice) -> Vec<u8> {
    let (ours, theirs) = (&bytes[block.ours.clone()], &bytes[block.theirs.clone()]);
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&bytes[..block.whole.start]);
    match choice {
        ConflictChoice::Ours => out.extend_from_slice(ours),
        ConflictChoice::Theirs => out.extend_from_slice(theirs),
        ConflictChoice::Both => {
            out.extend_from_slice(ours);
            if !ours.is_empty() && !ours.ends_with(b"\n") && !theirs.is_empty() {
                out.extend_from_slice(line_ending(bytes));
            }
            out.extend_from_slice(theirs);
        }
    }
    out.extend_from_slice(&bytes[block.whole.end..]);
    out
}

fn version_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// ---- the checkout

/// `conflict-marker-size` for each path, when the attribute sets a number.
fn marker_sizes(cwd: &Path, paths: &[String]) -> HashMap<String, usize> {
    if paths.is_empty() {
        return HashMap::new();
    }
    let mut args = vec!["check-attr", "-z", "conflict-marker-size", "--"];
    args.extend(paths.iter().map(String::as_str));
    let Ok(out) = git::run(cwd, &args) else { return HashMap::new() };
    // `<path>\0conflict-marker-size\0<value>\0`, once per path.
    let fields: Vec<&str> = out.split('\0').collect();
    fields
        .as_chunks::<3>()
        .0
        .iter()
        .filter_map(|record| record[2].trim().parse::<usize>().ok().filter(|size| *size > 0).map(|size| (record[0].to_string(), size)))
        .collect()
}

fn marker_size(cwd: &Path, path: &str) -> usize {
    marker_sizes(cwd, &[path.to_string()]).get(path).copied().unwrap_or(DEFAULT_MARKER_SIZE)
}

/// One index entry of an unmerged path.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stage {
    mode: String,
    stage: u8,
}

/// The unmerged index entries, by path.
fn unmerged_stages(cwd: &Path) -> Result<BTreeMap<String, Vec<Stage>>> {
    let out = git::run(cwd, &["ls-files", "--unmerged", "-z"])?;
    let mut by_path: BTreeMap<String, Vec<Stage>> = BTreeMap::new();
    // `<mode> <object> <stage>\t<path>`, once per stage.
    for (info, path) in out.split('\0').filter_map(|record| record.split_once('\t')) {
        let mut fields = info.split(' ');
        let (Some(mode), Some(_), Some(stage)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let Ok(stage) = stage.parse() else { continue };
        by_path.entry(path.to_string()).or_default().push(Stage { mode: mode.to_string(), stage });
    }
    Ok(by_path)
}

/// Why a path with these index entries and these bytes cannot be resolved
/// conflict by conflict; `None` when it can.
fn unsupported(stages: &[Stage], bytes: Option<&[u8]>) -> Option<String> {
    let has = |stage: u8| stages.iter().any(|entry| entry.stage == stage);
    if stages.iter().any(|entry| entry.mode == "160000") {
        return Some("This is a submodule: choose its commit in a terminal.".into());
    }
    if stages.iter().any(|entry| entry.mode == "120000") {
        return Some("This is a symbolic link: Git writes no conflict markers into one.".into());
    }
    if !has(2) {
        return Some("This branch deleted the file and the merge changed it: keep it or delete it as a whole.".into());
    }
    if !has(3) {
        return Some("The merge deleted the file and this branch changed it: keep it or delete it as a whole.".into());
    }
    if bytes.is_some_and(|bytes| bytes.contains(&0)) {
        return Some("This is a binary file: Git writes no conflict markers into one, so pick a side as a whole.".into());
    }
    None
}

/// How many conflict blocks each path holds now: 0 for a binary file, one
/// deleted on a side, or one that cannot be read.
pub(crate) fn counts(cwd: &Path, paths: &[String]) -> BTreeMap<String, usize> {
    let stages = unmerged_stages(cwd).unwrap_or_default();
    let sizes = marker_sizes(cwd, paths);
    paths
        .iter()
        .map(|path| {
            let entries = stages.get(path).map(Vec::as_slice).unwrap_or_default();
            let bytes = std::fs::symlink_metadata(cwd.join(path)).ok().filter(|meta| meta.is_file()).and_then(|_| std::fs::read(cwd.join(path)).ok());
            let count = match &bytes {
                Some(bytes) if unsupported(entries, Some(bytes)).is_none() => blocks(bytes, sizes.get(path).copied().unwrap_or(DEFAULT_MARKER_SIZE)).len(),
                _ => 0,
            };
            (path.clone(), count)
        })
        .collect()
}

/// That `path` names a file inside the checkout: relative, with no `..`.
fn check_path(path: &str) -> Result<()> {
    if path.is_empty() {
        bail!("No file was named.");
    }
    let parsed = Path::new(path);
    if parsed.is_absolute() || parsed.components().any(|part| !matches!(part, Component::Normal(_))) {
        bail!("\"{path}\" is not a path inside this checkout: it must be relative, without \"..\".");
    }
    Ok(())
}

/// What one command works on: the merge that was read, a path in it still
/// unmerged, and that path's bytes.
struct Loaded {
    stages: Vec<Stage>,
    /// `None` when the path is not a file on disk.
    bytes: Option<Vec<u8>>,
    size: usize,
}

fn load(cwd: &Path, head: &str, merge_head: &str, path: &str) -> Result<Loaded> {
    unfinished_merge::expect(cwd, head, merge_head)?;
    check_path(path)?;
    let Some(stages) = unmerged_stages(cwd)?.remove(path) else {
        bail!("{path} is not conflicted in this merge any more.");
    };
    let full = cwd.join(path);
    let bytes = match std::fs::symlink_metadata(&full) {
        Ok(meta) if meta.is_file() => Some(std::fs::read(&full).with_context(|| format!("reading {path}"))?),
        Ok(_) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).with_context(|| format!("reading {path}")),
    };
    Ok(Loaded { stages, bytes, size: marker_size(cwd, path) })
}

/// The number in a subject that names a pull request: `… (#209)` or
/// `Merge pull request #209 …`.
fn pr_of(subject: &str) -> Option<u64> {
    let digits = |text: &str| -> Option<u64> {
        let end = text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len());
        if end == 0 { None } else { text[..end].parse().ok() }
    };
    if let Some(rest) = subject.trim_end().strip_suffix(')') {
        if let Some(at) = rest.rfind("(#") {
            let number = &rest[at + 2..];
            if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) {
                return number.parse().ok();
            }
        }
    }
    subject.strip_prefix("Merge pull request #").and_then(digits)
}

/// The last commit in `range` that changed `path`.
fn last_commit(cwd: &Path, range: &str, path: &str) -> Option<SideCommit> {
    let out = git::run(cwd, &["--literal-pathspecs", "log", "-1", "--format=%H%x00%s%x00%an%x00%ct", range, "--", path]).ok()?;
    let mut fields = out.trim_end_matches('\n').splitn(4, '\0');
    let (id, subject, author, time) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?);
    if id.is_empty() {
        return None;
    }
    Some(SideCommit { id: id.into(), subject: subject.into(), author: author.into(), time: time.trim().parse().ok()?, pr: pr_of(subject) })
}

fn sides(cwd: &Path, head: &str, merge_head: &str, path: &str) -> (ConflictSide, ConflictSide) {
    let ours_branch = git::current_branch(cwd).unwrap_or_else(|| format!("commit {}", &head[..head.len().min(10)]));
    let theirs_branch = unfinished_merge::describe(&unfinished_merge::names_of(cwd, merge_head).unwrap_or_default(), merge_head);
    let base = git::run(cwd, &["merge-base", head, merge_head]).ok().map(|out| out.trim().to_string()).filter(|base| !base.is_empty());
    let range = |tip: &str| match &base {
        Some(base) => format!("{base}..{tip}"),
        None => tip.to_string(),
    };
    (
        ConflictSide { branch: ours_branch, commit: last_commit(cwd, &range(head), path) },
        ConflictSide { branch: theirs_branch, commit: last_commit(cwd, &range(merge_head), path) },
    )
}

fn describe_file(cwd: &Path, head: &str, merge_head: &str, path: &str, loaded: &Loaded) -> ConflictFile {
    let bytes = loaded.bytes.as_deref().unwrap_or_default();
    let unsupported = unsupported(&loaded.stages, loaded.bytes.as_deref());
    let (segments, conflicts) = match &unsupported {
        // A binary file is not shown as text.
        Some(_) if bytes.contains(&0) => (Vec::new(), 0),
        Some(_) if bytes.is_empty() => (Vec::new(), 0),
        Some(_) => (vec![ConflictSegment::Text { text: String::from_utf8_lossy(bytes).into_owned() }], 0),
        None => {
            let blocks = blocks(bytes, loaded.size);
            (segments(bytes, &blocks), blocks.len())
        }
    };
    let (ours, theirs) = sides(cwd, head, merge_head, path);
    ConflictFile { path: path.to_string(), version: version_of(bytes), segments, conflicts, ours, theirs, unsupported }
}

/// A conflicted file of the merge that was read, cut into its conflicts.
pub fn read(cwd: &Path, head: &str, merge_head: &str, path: &str) -> Result<ConflictFile> {
    let loaded = load(cwd, head, merge_head, path)?;
    if loaded.bytes.is_none() && unsupported(&loaded.stages, None).is_none() {
        bail!("{path} is not on disk any more.");
    }
    Ok(describe_file(cwd, head, merge_head, path, &loaded))
}

/// The file's bytes, refused when they cannot be resolved conflict by
/// conflict or are no longer the ones read as `version`.
fn current<'a>(path: &str, loaded: &'a Loaded, version: &str) -> Result<&'a [u8]> {
    if let Some(reason) = unsupported(&loaded.stages, loaded.bytes.as_deref()) {
        bail!("{path} cannot be resolved conflict by conflict. {reason}");
    }
    let Some(bytes) = loaded.bytes.as_deref() else { bail!("{path} is not on disk any more.") };
    if version_of(bytes) != version {
        bail!("{path} changed on disk since it was read. Nothing was written; read it again and choose again.");
    }
    Ok(bytes)
}

/// Write `bytes` over `path` by a rename from beside it, keeping its permissions.
fn write_atomically(full: &Path, bytes: &[u8]) -> Result<()> {
    let dir = full.parent().context("the file has no directory")?;
    let permissions = std::fs::metadata(full).with_context(|| format!("reading {}", full.display()))?.permissions();
    let mut temp = tempfile::Builder::new().prefix(".terminalx-resolve-").tempfile_in(dir).with_context(|| format!("writing beside {}", full.display()))?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    std::fs::set_permissions(temp.path(), permissions)?;
    temp.persist(full).map_err(|error| error.error).with_context(|| format!("replacing {}", full.display()))?;
    Ok(())
}

/// Replace conflict `index` with the chosen side, or both, and the file as
/// written. Refused when the file changed since `version`.
pub fn resolve(cwd: &Path, head: &str, merge_head: &str, path: &str, version: &str, index: usize, choice: ConflictChoice) -> Result<ConflictFile> {
    let loaded = load(cwd, head, merge_head, path)?;
    let bytes = current(path, &loaded, version)?;
    let Some(written) = resolved(bytes, loaded.size, index, choice) else {
        let count = blocks(bytes, loaded.size).len();
        bail!("{path} has no conflict {} to resolve; it has {count}.", index + 1);
    };
    write_atomically(&cwd.join(path), &written)?;
    read(cwd, head, merge_head, path)
}

/// Stage a file with no conflict left (`git add`). Refused when it changed
/// since `version`, still has conflict markers, or cannot be resolved
/// conflict by conflict.
pub fn mark_resolved(cwd: &Path, head: &str, merge_head: &str, path: &str, version: &str) -> Result<()> {
    let loaded = load(cwd, head, merge_head, path)?;
    let bytes = current(path, &loaded, version)?;
    match blocks(bytes, loaded.size).len() {
        0 => {}
        1 => bail!("{path} still has 1 conflict. Resolve it first."),
        n => bail!("{path} still has {n} conflicts. Resolve them first."),
    }
    git::run(cwd, &["--literal-pathspecs", "add", "--", path])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .current_dir(cwd)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.editor=true"])
            .args(args)
            .output()
            .unwrap()
    }

    fn ok(cwd: &Path, args: &[&str]) -> String {
        let out = git(cwd, args);
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn put(root: &Path, files: &[(&str, Option<&[u8]>)]) {
        for (path, bytes) in files {
            let full = root.join(path);
            match bytes {
                Some(bytes) => {
                    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
                    std::fs::write(full, bytes).unwrap();
                }
                None => std::fs::remove_file(full).unwrap(),
            }
        }
    }

    type Files<'a> = &'a [(&'a str, Option<&'a [u8]>)];

    /// A checkout on `raccoon/work` part way through merging `main`
    /// (`origin/main` points at it too), where `base` is the common
    /// ancestor's files and `ours`/`theirs` what each side changed.
    /// `config` is set in the repository first. HEAD and the merged commit.
    fn merging(config: &[(&str, &str)], base: Files, ours: Files, theirs: Files) -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        ok(root, &["init", "-q", "-b", "main"]);
        let fixed = [("user.name", "T"), ("user.email", "t@example.test"), ("commit.gpgsign", "false"), ("merge.conflictStyle", "merge"), ("core.autocrlf", "false")];
        for (key, value) in fixed.iter().chain(config) {
            ok(root, &["config", key, value]);
        }
        put(root, base);
        ok(root, &["add", "-A"]);
        ok(root, &["commit", "-qm", "first"]);
        ok(root, &["checkout", "-qb", "raccoon/work"]);
        put(root, ours);
        ok(root, &["add", "-A"]);
        ok(root, &["commit", "-qm", "Branch edit"]);
        let head = ok(root, &["rev-parse", "HEAD"]);
        ok(root, &["checkout", "-q", "main"]);
        put(root, theirs);
        ok(root, &["add", "-A"]);
        ok(root, &["commit", "-qm", "Tidy the notes (#209)"]);
        let merged = ok(root, &["rev-parse", "HEAD"]);
        ok(root, &["update-ref", "refs/remotes/origin/main", &merged]);
        ok(root, &["checkout", "-q", "raccoon/work"]);
        assert!(!git(root, &["merge", "--no-ff", "--no-commit", &merged]).status.success(), "the merge conflicts");
        (dir, head, merged)
    }

    // Five unchanged lines between the two edits: Git joins conflicts that
    // are three or fewer lines apart into one.
    const BASE: &[u8] = b"# Notes\none\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\ntwo\nend\n";
    const OURS: &[u8] = b"# Notes\none ours\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\ntwo ours\nend\n";
    const THEIRS: &[u8] = b"# Notes\none theirs\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\ntwo theirs\nend\n";

    /// `notes.md` with two conflicts, and an unrelated conflicted changelog.
    fn two_conflicts(config: &[(&str, &str)]) -> (tempfile::TempDir, String, String) {
        merging(
            config,
            &[("notes.md", Some(BASE)), ("CHANGELOG.md", Some(b"# Changes\n"))],
            &[("notes.md", Some(OURS)), ("CHANGELOG.md", Some(b"# Changes\n- branch\n"))],
            &[("notes.md", Some(THEIRS)), ("CHANGELOG.md", Some(b"# Changes\n- base\n"))],
        )
    }

    fn hunks(file: &ConflictFile) -> Vec<&ConflictHunk> {
        file.segments.iter().filter_map(|segment| if let ConflictSegment::Conflict { hunk } = segment { Some(hunk) } else { None }).collect()
    }

    fn joined(file: &ConflictFile) -> String {
        file.segments
            .iter()
            .map(|segment| match segment {
                ConflictSegment::Text { text } => text.clone(),
                ConflictSegment::Conflict { hunk } => format!("[{}|{}]", hunk.ours, hunk.theirs),
            })
            .collect()
    }

    // ---- parsing, on bytes alone

    #[test]
    fn plain_markers_are_cut_into_text_and_conflicts() {
        let bytes = b"a\n<<<<<<< HEAD\nours\n=======\ntheirs 1\ntheirs 2\n>>>>>>> main\nb\n<<<<<<<\n=======\nonly theirs\n>>>>>>>\n";
        let found = blocks(bytes, 7);
        assert_eq!(found.len(), 2);
        let segments = segments(bytes, &found);
        assert_eq!(
            segments,
            vec![
                ConflictSegment::Text { text: "a\n".into() },
                ConflictSegment::Conflict { hunk: ConflictHunk { index: 0, line: 2, ours: "ours\n".into(), theirs: "theirs 1\ntheirs 2\n".into(), base: None } },
                ConflictSegment::Text { text: "b\n".into() },
                ConflictSegment::Conflict { hunk: ConflictHunk { index: 1, line: 9, ours: "".into(), theirs: "only theirs\n".into(), base: None } },
            ]
        );
        let json = serde_json::to_value(&segments[1]).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "conflict", "hunk": {"index": 0, "line": 2, "ours": "ours\n", "theirs": "theirs 1\ntheirs 2\n", "base": null}}));
        assert_eq!(serde_json::to_value(&segments[0]).unwrap(), serde_json::json!({"kind": "text", "text": "a\n"}));
    }

    #[test]
    fn diff3_markers_carry_the_base() {
        let bytes = b"<<<<<<< HEAD\nours\n||||||| merged common ancestors\nbase\n=======\ntheirs\n>>>>>>> main\n";
        let found = blocks(bytes, 7);
        let ConflictSegment::Conflict { hunk } = &segments(bytes, &found)[0] else { panic!() };
        assert_eq!((hunk.ours.as_str(), hunk.base.as_deref(), hunk.theirs.as_str()), ("ours\n", Some("base\n"), "theirs\n"));
        // An empty base section is an empty base, not none.
        let bytes = b"<<<<<<< HEAD\nours\n|||||||\n=======\ntheirs\n>>>>>>> main\n";
        let ConflictSegment::Conflict { hunk } = &segments(bytes, &blocks(bytes, 7))[0] else { panic!() };
        assert_eq!(hunk.base.as_deref(), Some(""));
    }

    #[test]
    fn crlf_and_a_last_line_without_newline_are_kept_exactly() {
        let bytes = b"a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> main\r\nlast";
        let found = blocks(bytes, 7);
        assert_eq!(found.len(), 1);
        let segments = segments(bytes, &found);
        assert_eq!(segments[0], ConflictSegment::Text { text: "a\r\n".into() });
        let ConflictSegment::Conflict { hunk } = &segments[1] else { panic!() };
        assert_eq!((hunk.ours.as_str(), hunk.theirs.as_str()), ("ours\r\n", "theirs\r\n"));
        assert_eq!(segments[2], ConflictSegment::Text { text: "last".into() });
        assert_eq!(resolved(bytes, 7, 0, ConflictChoice::Theirs).unwrap(), b"a\r\ntheirs\r\nlast");
        assert_eq!(resolved(bytes, 7, 0, ConflictChoice::Both).unwrap(), b"a\r\nours\r\ntheirs\r\nlast");
        // A closing marker that is the file's last line, without a newline.
        let bytes = b"<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main";
        assert_eq!(resolved(bytes, 7, 0, ConflictChoice::Ours).unwrap(), b"ours\n");
    }

    #[test]
    fn both_puts_the_files_line_ending_between_sides_when_ours_has_none() {
        // Built by hand: Git always ends a side with a line ending, but a
        // person editing the markers may not.
        let bytes = b"x\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> main\r\n";
        let mut block = blocks(bytes, 7).remove(0);
        block.ours.end -= 2;
        assert_eq!(&bytes[block.ours.clone()], b"ours");
        assert_eq!(splice(bytes, &block, ConflictChoice::Both), b"x\r\nours\r\ntheirs\r\n");
        assert_eq!(splice(bytes, &block, ConflictChoice::Ours), b"x\r\nours");
        assert_eq!(line_ending(bytes), b"\r\n");
        assert_eq!(line_ending(b"a\nb\r\n"), b"\n");
        assert_eq!(line_ending(b"no newline"), b"\n");
    }

    #[test]
    fn a_marker_is_its_exact_length_followed_by_a_space_or_the_line_end() {
        assert_eq!(marker(b"<<<<<<< HEAD\n", 7), Some(Marker::Open));
        assert_eq!(marker(b"<<<<<<<\r\n", 7), Some(Marker::Open));
        assert_eq!(marker(b">>>>>>>", 7), Some(Marker::Close));
        assert_eq!(marker(b"<<<<<<<< HEAD\n", 7), None, "eight is not seven");
        assert_eq!(marker(b"=======x\n", 7), None);
        assert_eq!(marker(b" =======\n", 7), None, "not at line start");
        assert_eq!(marker(b"<<<<<<<<<< HEAD\n", 10), Some(Marker::Open));
        assert_eq!(marker(b"<<<<<<< HEAD\n", 10), None);
    }

    #[test]
    fn a_malformed_block_is_kept_as_text() {
        // Never closed.
        let bytes = b"a\n<<<<<<< HEAD\nours\n=======\ntheirs\n";
        assert!(blocks(bytes, 7).is_empty());
        assert_eq!(segments(bytes, &[]), vec![ConflictSegment::Text { text: String::from_utf8_lossy(bytes).into() }]);
        // Closed before it was split.
        assert!(blocks(b"<<<<<<< HEAD\nours\n>>>>>>> main\n", 7).is_empty());
        // A base section after the split.
        assert!(blocks(b"<<<<<<< HEAD\nours\n=======\ntheirs\n|||||||\n>>>>>>> main\n", 7).is_empty());
        // Two splits.
        assert!(blocks(b"<<<<<<< HEAD\nours\n=======\n=======\n>>>>>>> main\n", 7).is_empty());
        // A stray opening marker before a well-formed block: only the block is a conflict.
        let bytes = b"<<<<<<< stray\nx\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\ny\n";
        let found = blocks(bytes, 7);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 3);
        assert_eq!(segments(bytes, &found)[0], ConflictSegment::Text { text: "<<<<<<< stray\nx\n".into() });
        // Out of range.
        assert_eq!(resolved(bytes, 7, 1, ConflictChoice::Ours), None);
    }

    #[test]
    fn pull_requests_are_read_from_subjects() {
        assert_eq!(pr_of("Tidy the notes (#209)"), Some(209));
        assert_eq!(pr_of("Merge pull request #12 from terminalx-ai/raccoon/x"), Some(12));
        assert_eq!(pr_of("Fix (#12) in the middle"), None);
        assert_eq!(pr_of("Plain subject"), None);
        assert_eq!(pr_of("Odd (#)"), None);
        assert_eq!(pr_of("Odd (#1a)"), None);
    }

    #[test]
    fn choices_are_read_as_the_contract_spells_them() {
        for (text, choice) in [("\"ours\"", ConflictChoice::Ours), ("\"theirs\"", ConflictChoice::Theirs), ("\"both\"", ConflictChoice::Both)] {
            assert_eq!(serde_json::from_str::<ConflictChoice>(text).unwrap(), choice);
        }
        assert!(serde_json::from_str::<ConflictChoice>("\"Ours\"").is_err());
    }

    // ---- on real merges

    #[test]
    fn a_conflicted_file_is_read_with_its_sides_and_the_json_the_ui_reads() {
        let (dir, head, merged) = two_conflicts(&[]);
        let root = dir.path();
        let file = read(root, &head, &merged, "notes.md").unwrap();
        assert_eq!(file.conflicts, 2);
        assert_eq!(file.unsupported, None);
        let found = hunks(&file);
        assert_eq!((found[0].index, found[0].line, found[0].ours.as_str(), found[0].theirs.as_str()), (0, 2, "one ours\n", "one theirs\n"));
        assert_eq!((found[1].index, found[1].ours.as_str(), found[1].theirs.as_str()), (1, "two ours\n", "two theirs\n"));
        assert_eq!(file.version, version_of(&std::fs::read(root.join("notes.md")).unwrap()));
        assert_eq!(file.version.len(), 64);
        assert!(file.version.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));

        assert_eq!(file.ours.branch, "raccoon/work");
        let ours = file.ours.commit.as_ref().unwrap();
        assert_eq!((ours.id.as_str(), ours.subject.as_str(), ours.author.as_str(), ours.pr), (head.as_str(), "Branch edit", "T", None));
        assert!(ours.time > 1_600_000_000);
        assert_eq!(file.theirs.branch, "origin/main");
        let theirs = file.theirs.commit.as_ref().unwrap();
        assert_eq!((theirs.id.as_str(), theirs.subject.as_str(), theirs.pr), (merged.as_str(), "Tidy the notes (#209)", Some(209)));

        let json = serde_json::to_value(&file).unwrap();
        for key in ["path", "version", "segments", "conflicts", "ours", "theirs", "unsupported"] {
            assert!(json.get(key).is_some(), "{key} in {json}");
        }
        assert_eq!(json["ours"]["commit"]["time"], ours.time);
        assert_eq!(json["theirs"]["commit"]["pr"], 209);

        // Reading wrote nothing.
        assert_eq!(read(root, &head, &merged, "notes.md").unwrap(), file);
    }

    #[test]
    fn a_side_that_never_touched_the_file_has_no_commit_and_a_detached_head_is_named_by_its_commit() {
        let (dir, head, merged) = two_conflicts(&[]);
        let root = dir.path();
        ok(root, &["merge", "--abort"]);
        ok(root, &["checkout", "-q", "--detach", &head]);
        assert!(!git(root, &["merge", "--no-ff", "--no-commit", &merged]).status.success());
        let file = read(root, &head, &merged, "notes.md").unwrap();
        assert_eq!(file.ours.branch, format!("commit {}", &head[..10]));
        assert_eq!(file.theirs.branch, "origin/main");

        // The commit since the merge base that changed a path, and none in a range that is empty.
        let side = last_commit(root, &format!("{head}..{merged}"), "CHANGELOG.md").unwrap();
        assert_eq!(side.id, merged);
        assert_eq!(last_commit(root, &format!("{merged}..{merged}"), "CHANGELOG.md"), None);
    }

    #[test]
    fn resolving_one_conflict_changes_only_that_one() {
        for (choice, first, second) in [
            (ConflictChoice::Ours, 0, "one ours\n"),
            (ConflictChoice::Theirs, 0, "one theirs\n"),
            (ConflictChoice::Both, 0, "one ours\none theirs\n"),
            (ConflictChoice::Ours, 1, "two ours\n"),
            (ConflictChoice::Theirs, 1, "two theirs\n"),
            (ConflictChoice::Both, 1, "two ours\ntwo theirs\n"),
        ] {
            let (dir, head, merged) = two_conflicts(&[]);
            let root = dir.path();
            let before = std::fs::read(root.join("notes.md")).unwrap();
            let file = read(root, &head, &merged, "notes.md").unwrap();
            let after = resolve(root, &head, &merged, "notes.md", &file.version, first, choice).unwrap();
            let on_disk = std::fs::read(root.join("notes.md")).unwrap();
            assert_eq!(after.version, version_of(&on_disk));
            assert_ne!(after.version, file.version);
            assert_eq!(after.conflicts, 1, "{choice:?} {first}");
            // The other conflict, as it was.
            let other = hunks(&after)[0];
            assert_eq!(other.index, 0);
            if first == 0 {
                assert_eq!((other.ours.as_str(), other.theirs.as_str()), ("two ours\n", "two theirs\n"));
            } else {
                assert_eq!((other.ours.as_str(), other.theirs.as_str()), ("one ours\n", "one theirs\n"));
                assert_eq!(other.line, 2);
            }
            // Only the chosen block's bytes changed.
            let block = blocks(&before, 7).remove(first);
            let mut expected = before[..block.whole.start].to_vec();
            expected.extend_from_slice(second.as_bytes());
            expected.extend_from_slice(&before[block.whole.end..]);
            assert_eq!(String::from_utf8(on_disk).unwrap(), String::from_utf8(expected).unwrap(), "{choice:?} {first}");
            // Still conflicted in the index until it is marked.
            assert!(unfinished_merge::read(root).unwrap().unwrap().conflicted.contains(&"notes.md".to_string()));
        }
    }

    #[test]
    fn a_crlf_file_is_resolved_with_its_line_endings() {
        let (dir, head, merged) = merging(
            &[],
            &[("win.txt", Some(b"a\r\nmid\r\nz"))],
            &[("win.txt", Some(b"a\r\nmid ours\r\nz"))],
            &[("win.txt", Some(b"a\r\nmid theirs\r\nz"))],
        );
        let root = dir.path();
        let file = read(root, &head, &merged, "win.txt").unwrap();
        assert_eq!(file.conflicts, 1);
        let hunk = hunks(&file)[0];
        assert_eq!((hunk.ours.as_str(), hunk.theirs.as_str()), ("mid ours\r\n", "mid theirs\r\n"));
        resolve(root, &head, &merged, "win.txt", &file.version, 0, ConflictChoice::Both).unwrap();
        assert_eq!(std::fs::read(root.join("win.txt")).unwrap(), b"a\r\nmid ours\r\nmid theirs\r\nz");
    }

    #[test]
    fn diff3_and_zdiff3_markers_from_git_carry_the_base() {
        for style in ["diff3", "zdiff3"] {
            let (dir, head, merged) = two_conflicts(&[("merge.conflictStyle", style)]);
            let root = dir.path();
            let on_disk = std::fs::read_to_string(root.join("notes.md")).unwrap();
            assert!(on_disk.contains("\n||||||| "), "{style}: git wrote a base section: {on_disk}");
            let file = read(root, &head, &merged, "notes.md").unwrap();
            assert_eq!(file.conflicts, 2, "{style}");
            let found = hunks(&file);
            assert_eq!((found[0].ours.as_str(), found[0].base.as_deref(), found[0].theirs.as_str()), ("one ours\n", Some("one\n"), "one theirs\n"), "{style}");
            assert_eq!(found[1].base.as_deref(), Some("two\n"), "{style}");
            let after = resolve(root, &head, &merged, "notes.md", &file.version, 1, ConflictChoice::Theirs).unwrap();
            assert_eq!(hunks(&after)[0].base.as_deref(), Some("one\n"), "{style}");
            assert!(std::fs::read_to_string(root.join("notes.md")).unwrap().contains("keep 5\ntwo theirs\nend\n"), "{style}");
        }
    }

    #[test]
    fn a_custom_marker_size_is_read_from_the_attributes() {
        // Seven-character runs in the text are not markers once the size is 10.
        let base: &[u8] = b"=======\nmid\n<<<<<<< not a marker\n";
        let (dir, head, merged) = merging(
            &[],
            &[(".gitattributes", Some(b"notes.md conflict-marker-size=10\n")), ("notes.md", Some(base))],
            &[("notes.md", Some(b"=======\nmid ours\n<<<<<<< not a marker\n"))],
            &[("notes.md", Some(b"=======\nmid theirs\n<<<<<<< not a marker\n"))],
        );
        let root = dir.path();
        assert_eq!(marker_size(root, "notes.md"), 10);
        assert_eq!(marker_size(root, "other.md"), 7);
        let on_disk = std::fs::read_to_string(root.join("notes.md")).unwrap();
        assert!(on_disk.contains("\n<<<<<<<<<< "), "git wrote ten-character markers: {on_disk}");
        let file = read(root, &head, &merged, "notes.md").unwrap();
        assert_eq!(file.conflicts, 1);
        let hunk = hunks(&file)[0];
        assert_eq!((hunk.ours.as_str(), hunk.theirs.as_str()), ("mid ours\n", "mid theirs\n"));
        assert_eq!(file.segments[0], ConflictSegment::Text { text: "=======\n".into() });
        assert_eq!(hunk.line, 2);
        assert_eq!(unfinished_merge::read(root).unwrap().unwrap().conflict_counts["notes.md"], 1);
        let after = resolve(root, &head, &merged, "notes.md", &file.version, 0, ConflictChoice::Ours).unwrap();
        assert_eq!(after.conflicts, 0);
        assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"=======\nmid ours\n<<<<<<< not a marker\n");
        mark_resolved(root, &head, &merged, "notes.md", &after.version).unwrap();
    }

    #[test]
    fn a_stale_version_is_refused_and_the_file_is_left_alone() {
        let (dir, head, merged) = two_conflicts(&[]);
        let root = dir.path();
        let file = read(root, &head, &merged, "notes.md").unwrap();
        // Someone edits the file after it was read.
        let edited = format!("{}extra\n", std::fs::read_to_string(root.join("notes.md")).unwrap());
        std::fs::write(root.join("notes.md"), &edited).unwrap();
        let refused = resolve(root, &head, &merged, "notes.md", &file.version, 0, ConflictChoice::Ours).unwrap_err().to_string();
        assert!(refused.contains("notes.md changed on disk since it was read"), "{refused}");
        assert_eq!(std::fs::read_to_string(root.join("notes.md")).unwrap(), edited);
        let refused = mark_resolved(root, &head, &merged, "notes.md", &file.version).unwrap_err().to_string();
        assert!(refused.contains("changed on disk since it was read"), "{refused}");
        assert_eq!(std::fs::read_to_string(root.join("notes.md")).unwrap(), edited);
        assert!(unfinished_merge::read(root).unwrap().unwrap().conflicted.contains(&"notes.md".to_string()), "not staged");
        // No temporary file was left beside it.
        let names: Vec<String> = std::fs::read_dir(root).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(!names.iter().any(|name| name.starts_with(".terminalx-resolve-")), "{names:?}");
    }

    #[test]
    fn marking_is_refused_while_markers_remain_and_stages_the_file_once_none_do() {
        let (dir, head, merged) = two_conflicts(&[]);
        let root = dir.path();
        let file = read(root, &head, &merged, "notes.md").unwrap();
        let refused = mark_resolved(root, &head, &merged, "notes.md", &file.version).unwrap_err().to_string();
        assert_eq!(refused, "notes.md still has 2 conflicts. Resolve them first.");
        let file = resolve(root, &head, &merged, "notes.md", &file.version, 0, ConflictChoice::Theirs).unwrap();
        let refused = mark_resolved(root, &head, &merged, "notes.md", &file.version).unwrap_err().to_string();
        assert_eq!(refused, "notes.md still has 1 conflict. Resolve it first.");
        let merge = unfinished_merge::read(root).unwrap().unwrap();
        assert_eq!(merge.conflicted, ["CHANGELOG.md", "notes.md"]);
        assert_eq!(merge.conflict_counts["notes.md"], 1);

        let file = resolve(root, &head, &merged, "notes.md", &file.version, 0, ConflictChoice::Ours).unwrap();
        assert_eq!(file.conflicts, 0);
        assert_eq!(std::fs::read(root.join("notes.md")).unwrap(), b"# Notes\none theirs\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\ntwo ours\nend\n");
        mark_resolved(root, &head, &merged, "notes.md", &file.version).unwrap();
        let merge = unfinished_merge::read(root).unwrap().unwrap();
        assert_eq!(merge.conflicted, ["CHANGELOG.md"]);
        assert!(!merge.conflict_counts.contains_key("notes.md"));
        assert_eq!(ok(root, &["diff", "--cached", "--name-only", "--", "notes.md"]), "notes.md");
        // Once staged it is no longer a conflict of this merge.
        let refused = read(root, &head, &merged, "notes.md").unwrap_err().to_string();
        assert_eq!(refused, "notes.md is not conflicted in this merge any more.");
    }

    #[cfg(unix)]
    #[test]
    fn a_resolve_keeps_the_files_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, head, merged) = merging(
            &[],
            &[("run.sh", Some(b"#!/bin/sh\necho base\n"))],
            &[("run.sh", Some(b"#!/bin/sh\necho ours\n"))],
            &[("run.sh", Some(b"#!/bin/sh\necho theirs\n"))],
        );
        let root = dir.path();
        std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let file = read(root, &head, &merged, "run.sh").unwrap();
        resolve(root, &head, &merged, "run.sh", &file.version, 0, ConflictChoice::Theirs).unwrap();
        assert_eq!(std::fs::metadata(root.join("run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(std::fs::read_to_string(root.join("run.sh")).unwrap(), "#!/bin/sh\necho theirs\n");
    }

    #[test]
    fn binary_and_deleted_on_one_side_files_are_unsupported() {
        let (dir, head, merged) = merging(
            &[],
            &[("logo.bin", Some(b"\x00\x01base")), ("gone-here.md", Some(b"kept\n")), ("gone-there.md", Some(b"kept\n"))],
            &[("logo.bin", Some(b"\x00\x01ours")), ("gone-here.md", None), ("gone-there.md", Some(b"kept\nours\n"))],
            &[("logo.bin", Some(b"\x00\x01theirs")), ("gone-here.md", Some(b"kept\ntheirs\n")), ("gone-there.md", None)],
        );
        let root = dir.path();
        let merge = unfinished_merge::read(root).unwrap().unwrap();
        assert_eq!(merge.conflicted, ["gone-here.md", "gone-there.md", "logo.bin"]);
        for path in &merge.conflicted {
            assert_eq!(merge.conflict_counts[path], 0, "{path}");
        }

        let binary = read(root, &head, &merged, "logo.bin").unwrap();
        assert!(binary.unsupported.as_deref().unwrap().contains("binary"), "{:?}", binary.unsupported);
        assert_eq!((binary.conflicts, binary.segments.len()), (0, 0));
        let here = read(root, &head, &merged, "gone-here.md").unwrap();
        assert!(here.unsupported.as_deref().unwrap().starts_with("This branch deleted the file"), "{:?}", here.unsupported);
        assert_eq!(here.conflicts, 0);
        let there = read(root, &head, &merged, "gone-there.md").unwrap();
        assert!(there.unsupported.as_deref().unwrap().starts_with("The merge deleted the file"), "{:?}", there.unsupported);
        assert_eq!(joined(&there), "kept\nours\n");

        for file in [&binary, &here, &there] {
            let before = std::fs::read(root.join(&file.path)).unwrap();
            let refused = resolve(root, &head, &merged, &file.path, &file.version, 0, ConflictChoice::Ours).unwrap_err().to_string();
            assert!(refused.contains("cannot be resolved conflict by conflict"), "{refused}");
            let refused = mark_resolved(root, &head, &merged, &file.path, &file.version).unwrap_err().to_string();
            assert!(refused.contains("cannot be resolved conflict by conflict"), "{refused}");
            assert_eq!(std::fs::read(root.join(&file.path)).unwrap(), before);
        }
        assert_eq!(unfinished_merge::read(root).unwrap().unwrap().conflicted.len(), 3, "nothing was staged");
    }

    #[test]
    fn paths_outside_the_checkout_or_not_conflicted_and_other_merges_are_refused() {
        let (dir, head, merged) = two_conflicts(&[]);
        let root = dir.path();
        for path in ["../notes.md", "/etc/passwd", "./notes.md", "a/../notes.md", ""] {
            let refused = read(root, &head, &merged, path).unwrap_err().to_string();
            assert!(refused.contains("not a path inside this checkout") || refused == "No file was named.", "{path}: {refused}");
        }
        std::fs::write(root.join("plain.txt"), "x\n").unwrap();
        assert_eq!(read(root, &head, &merged, "plain.txt").unwrap_err().to_string(), "plain.txt is not conflicted in this merge any more.");
        // A pathspec character is a file name, not a pattern.
        assert!(read(root, &head, &merged, "*.md").is_err());
        assert!(read(root, &head, &head, "notes.md").unwrap_err().to_string().contains(&format!("not {}", &head[..10])));
        assert!(read(root, &merged, &merged, "notes.md").unwrap_err().to_string().contains("HEAD moved"));
        let file = read(root, &head, &merged, "notes.md").unwrap();
        assert!(resolve(root, &head, &merged, "notes.md", &file.version, 2, ConflictChoice::Ours).unwrap_err().to_string().contains("has no conflict 3 to resolve; it has 2"));
        ok(root, &["merge", "--abort"]);
        assert!(resolve(root, &head, &merged, "notes.md", &file.version, 0, ConflictChoice::Ours).unwrap_err().to_string().contains("No merge is in progress"));
    }
}
