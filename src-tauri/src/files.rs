//! The project file index behind `@` mentions and quick-open.
//!
//! One walk per directory (honouring .gitignore), held in memory and rebuilt
//! when asked; searches are fuzzy over the relative path with a bias toward
//! filename matches. Capped so a monorepo can't pin a core.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};

const MAX_FILES: usize = 60_000;
/// The index with ignored files: every file of the plain index, then ignored
/// ones up to this many in all. A `node_modules` alone often passes 60,000.
const MAX_FILES_WITH_IGNORED: usize = 250_000;
const FRESH_FOR: Duration = Duration::from_secs(20);

#[derive(Clone)]
struct Index {
    built: Instant,
    files: Vec<String>,
    truncated: bool,
}

/// One index per checkout and per mode: with `include_ignored` it also holds
/// what `.gitignore` (and the folders skipped by name) would leave out.
fn cache() -> &'static Mutex<HashMap<(PathBuf, bool), Index>> {
    static C: OnceLock<Mutex<HashMap<(PathBuf, bool), Index>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The files of a checkout, hidden ones included, as the file tree shows
/// them, walked in name order and cut at `cap`. Without `include_ignored`,
/// what Git ignores is skipped, and so are `node_modules` and `target` in a
/// folder that has no `.gitignore` for them. `keep` drops files as they are
/// found, before they count against the cap.
fn walk(root: &Path, include_ignored: bool, cap: usize, keep: impl Fn(&str) -> bool) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .ignore(!include_ignored)
        .git_ignore(!include_ignored)
        .git_global(!include_ignored)
        .git_exclude(!include_ignored)
        .require_git(false)
        .follow_links(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(move |e| {
            let name = e.file_name().to_string_lossy();
            if name == ".git" || name == ".raccoon" || name == ".DS_Store" {
                return false;
            }
            include_ignored || !(name == "node_modules" || name == "target")
        })
        .build();
    for entry in walker.flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let Ok(rel) = entry.path().strip_prefix(root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !keep(&rel) {
                continue;
            }
            if out.len() >= cap {
                return (out, true);
            }
            out.push(rel);
        }
    }
    (out, false)
}

/// Build a checkout's index. With ignored files it is the plain index whole,
/// then the ignored files after it, so no file Git tracks is ever crowded
/// out by a dependency folder; `truncated` says either part was cut.
fn build(root: &Path, include_ignored: bool, caps: (usize, usize)) -> Index {
    let (plain_cap, total_cap) = caps;
    if !include_ignored {
        let (files, truncated) = walk(root, false, plain_cap, |_| true);
        return Index { built: Instant::now(), files, truncated };
    }
    let plain = cached(root, false).unwrap_or_else(|| store(root, false, build(root, false, caps)));
    let seen: std::collections::HashSet<&str> = plain.files.iter().map(String::as_str).collect();
    let room = total_cap.saturating_sub(plain.files.len());
    let (ignored, cut) = walk(root, true, room, |rel| !seen.contains(rel));
    let mut files = plain.files.clone();
    files.extend(ignored);
    Index { built: Instant::now(), files, truncated: plain.truncated || cut }
}

fn cached(root: &Path, include_ignored: bool) -> Option<Index> {
    let c = cache().lock().unwrap();
    c.get(&(root.to_path_buf(), include_ignored)).filter(|ix| ix.built.elapsed() < FRESH_FOR).cloned()
}

fn store(root: &Path, include_ignored: bool, ix: Index) -> Index {
    cache().lock().unwrap().insert((root.to_path_buf(), include_ignored), ix.clone());
    ix
}

/// The cached index, or a fresh walk. The cache lock is never held while
/// walking: a slow walk of one checkout (or of ignored files) holds up no
/// other search. Two searches that both miss may both walk; the last one wins.
fn index_for(root: &Path, include_ignored: bool) -> (Vec<String>, bool) {
    let ix = cached(root, include_ignored).unwrap_or_else(|| store(root, include_ignored, build(root, include_ignored, (MAX_FILES, MAX_FILES_WITH_IGNORED))));
    (ix.files, ix.truncated)
}

pub fn invalidate(root: &Path) {
    cache().lock().unwrap().retain(|(path, _), _| path != root);
}

/// How many files a search looks through (quick open's footer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCount {
    pub files: usize,
    /// The walk stopped at its cap: there are at least `files`.
    pub truncated: bool,
}

pub fn count(root: &Path, include_ignored: bool) -> FileCount {
    let (files, truncated) = index_for(root, include_ignored);
    FileCount { files: files.len(), truncated }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub score: u32,
}

/// Fuzzy-search the index. An empty query lists the shallowest files first,
/// which is what a bare `@` should open on. `include_ignored` searches the
/// files Git ignores as well.
pub fn search(root: &Path, query: &str, limit: usize, include_ignored: bool) -> Result<Vec<FileHit>> {
    let (files, _) = index_for(root, include_ignored);
    let name_of = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
    if query.trim().is_empty() {
        let mut v: Vec<&String> = files.iter().collect();
        v.sort_by_key(|p| (p.matches('/').count(), p.to_lowercase()));
        return Ok(v.into_iter().take(limit).map(|p| FileHit { path: p.clone(), name: name_of(p), score: 0 }).collect());
    }
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut buf = Vec::new();
    let mut hits: Vec<(u32, &String)> = files
        .iter()
        .filter_map(|p| {
            let hay = Utf32Str::new(p, &mut buf);
            let mut score = pattern.score(hay, &mut matcher)?;
            // A match in the file name is worth more than one in a directory.
            let name = name_of(p);
            let mut nb = Vec::new();
            if let Some(ns) = pattern.score(Utf32Str::new(&name, &mut nb), &mut matcher) {
                score = score.max(ns + 100);
            }
            Some((score, p))
        })
        .collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())));
    Ok(hits.into_iter().take(limit).map(|(score, p)| FileHit { path: p.clone(), name: name_of(p), score }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_and_matches_names_first() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir_all(p.join("src/components")).unwrap();
        std::fs::create_dir_all(p.join("node_modules/x")).unwrap();
        std::fs::write(p.join("src/components/Button.tsx"), "").unwrap();
        std::fs::write(p.join("src/button.css"), "").unwrap();
        std::fs::write(p.join("README.md"), "").unwrap();
        std::fs::write(p.join("node_modules/x/button.js"), "").unwrap();
        let all = search(p, "", 10, false).unwrap();
        assert_eq!(all[0].path, "README.md");
        assert!(all.iter().all(|h| !h.path.starts_with("node_modules")));
        let hits = search(p, "button", 10, false).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.path == "src/components/Button.tsx"));
        let hits = search(p, "readme", 10, false).unwrap();
        assert_eq!(hits[0].path, "README.md");
    }

    #[test]
    fn includes_ignored_files_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir_all(p.join(".github/workflows")).unwrap();
        std::fs::create_dir_all(p.join("node_modules/left-pad")).unwrap();
        std::fs::create_dir_all(p.join("dist")).unwrap();
        std::fs::create_dir_all(p.join(".git")).unwrap();
        std::fs::write(p.join(".gitignore"), ".env.local\ndist/\n").unwrap();
        std::fs::write(p.join(".github/workflows/ci.yml"), "").unwrap();
        std::fs::write(p.join(".env.local"), "").unwrap();
        std::fs::write(p.join("dist/bundle.js"), "").unwrap();
        std::fs::write(p.join("node_modules/left-pad/index.js"), "").unwrap();
        std::fs::write(p.join(".git/config"), "").unwrap();
        std::fs::write(p.join("main.rs"), "").unwrap();

        // Hidden files are searched, as the tree shows them; ignored ones are not.
        assert_eq!(search(p, "ci.yml", 10, false).unwrap()[0].path, ".github/workflows/ci.yml");
        assert!(search(p, "env.local", 10, false).unwrap().is_empty());
        assert!(search(p, "bundle", 10, false).unwrap().is_empty());
        assert!(search(p, "left-pad", 10, false).unwrap().is_empty());
        assert_eq!(count(p, false).files, 3, "{:?}", search(p, "", 10, false).unwrap());

        // Asked to, the same search finds them, and the two modes keep their own index.
        assert_eq!(search(p, "env.local", 10, true).unwrap()[0].path, ".env.local");
        assert_eq!(search(p, "bundle", 10, true).unwrap()[0].path, "dist/bundle.js");
        assert_eq!(search(p, "left-pad", 10, true).unwrap()[0].path, "node_modules/left-pad/index.js");
        assert!(search(p, "", 20, true).unwrap().iter().all(|h| !h.path.starts_with(".git/")));
        assert_eq!(count(p, true), FileCount { files: 6, truncated: false });
        assert!(search(p, "env.local", 10, false).unwrap().is_empty());

        invalidate(p);
        std::fs::write(p.join("lib.rs"), "").unwrap();
        assert_eq!(count(p, false).files, 4);
        assert_eq!(count(p, true).files, 7);
    }

    #[test]
    fn ignored_files_never_crowd_out_the_plain_index() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        // `aaa` sorts, and so walks, before `src`: a capped walk of everything would fill up on it.
        std::fs::create_dir_all(p.join("aaa_deps/pkg")).unwrap();
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::write(p.join(".gitignore"), "aaa_deps/\n").unwrap();
        for i in 0..6 {
            std::fs::write(p.join(format!("aaa_deps/pkg/f{i}.js")), "").unwrap();
        }
        std::fs::write(p.join("src/main.rs"), "").unwrap();
        std::fs::write(p.join("src/lib.rs"), "").unwrap();

        let ix = build(p, true, (100, 6));
        assert_eq!(&ix.files[..3], [".gitignore", "src/lib.rs", "src/main.rs"]);
        assert_eq!(ix.files[3..], ["aaa_deps/pkg/f0.js", "aaa_deps/pkg/f1.js", "aaa_deps/pkg/f2.js"]);
        assert!(ix.truncated, "the cut is reported");

        let whole = build(p, true, (100, 100));
        assert_eq!(whole.files.len(), 9);
        assert!(!whole.truncated);
        assert_eq!(whole.files.iter().filter(|f| f.as_str() == "src/main.rs").count(), 1, "no file listed twice");
    }

    #[test]
    fn mention_and_phone_searches_see_hidden_files_as_the_tree_does() {
        // Chat @ mentions (`search_files`) and the phone's workspace search (remote/server.rs)
        // both go through `search`: tracked dotfiles are found, ignored ones and .git are not.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir_all(p.join(".vscode")).unwrap();
        std::fs::create_dir_all(p.join(".git")).unwrap();
        std::fs::write(p.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(p.join(".vscode/settings.json"), "").unwrap();
        std::fs::write(p.join(".env"), "").unwrap();
        std::fs::write(p.join(".git/HEAD"), "").unwrap();
        let all: Vec<String> = search(p, "", 50, false).unwrap().into_iter().map(|h| h.path).collect();
        assert!(all.contains(&".vscode/settings.json".to_string()));
        assert!(!all.iter().any(|f| f == ".env" || f.starts_with(".git/")));
        assert_eq!(list_all(p, 50).unwrap().paths.len(), all.len(), "the same files the tree lists");
    }
}

// ------------------------------------------------------------------ tree, text, search

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Relative to the root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
}

/// One level of the tree: what git would track, dot-files included, `.git`
/// and the app's own worktree folder left out. Directories first.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<DirEntry>> {
    let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name == ".git" || name == ".raccoon" || name == ".DS_Store")
        })
        .build();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let path = entry.path().strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        out.push(DirEntry { name: entry.file_name().to_string_lossy().into_owned(), path, is_dir });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Every file the All files tree can show, for its name filter: the same
/// rules as [`list_dir`] (hidden files included, `.gitignore`d ones left
/// out), walked to the bottom. `truncated` when `limit` cut it short.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub paths: Vec<String>,
    pub truncated: bool,
}

pub fn list_all(root: &Path, limit: usize) -> Result<FileList> {
    let mut paths = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name == ".git" || name == ".raccoon" || name == ".DS_Store")
        })
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if paths.len() >= limit {
            return Ok(FileList { paths, truncated: true });
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            paths.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(FileList { paths, truncated: false })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub mtime_ms: u64,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathInfo {
    pub path: String,
    pub root: String,
    pub rel: String,
    pub kind: LocalPathKind,
    pub text: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalPathKind {
    File,
    Directory,
}

const MAX_TEXT: u64 = 4 * 1024 * 1024;

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn read_text(path: &Path) -> Result<TextFile> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let bytes = if size > MAX_TEXT {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        let mut buf = vec![0u8; MAX_TEXT as usize];
        let n = f.read(&mut buf)?;
        buf.truncate(n);
        buf
    } else {
        std::fs::read(path)?
    };
    let binary = bytes.iter().take(8192).any(|&b| b == 0);
    let content = if binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() };
    Ok(TextFile { content, mtime_ms: mtime_ms(&meta), size, binary, truncated: size > MAX_TEXT })
}

pub fn write_text(path: &Path, content: &str) -> Result<u64> {
    anyhow::ensure!(crate::media_types::media_type(path).is_none(), "Media files are read-only in the file pane");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(mtime_ms(&std::fs::metadata(path)?))
}

pub fn stat_mtime(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| mtime_ms(&m))
}

/// Resolve a link only after a local webview activation. This deliberately is
/// not part of ACP or paired RPC: it returns metadata, never file contents.
pub fn inspect_local_path(base: &Path, requested: &Path) -> Result<LocalPathInfo> {
    let candidate = if requested.is_absolute() { requested.to_path_buf() } else { base.join(requested) };
    let path = existing_local_path(&candidate)?;
    let metadata = path.metadata()?;
    let kind = if metadata.is_dir() {
        LocalPathKind::Directory
    } else if metadata.is_file() {
        LocalPathKind::File
    } else {
        anyhow::bail!("Destination {} is not a regular file or folder", path.display());
    };

    let canonical_base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let (root, rel) = if let Ok(relative) = path.strip_prefix(&canonical_base) {
        (canonical_base, relative.to_path_buf())
    } else if path.parent().is_none() {
        // Filesystem roots are valid folder destinations even though they do
        // not have a parent from which to construct an editor-relative path.
        (path.clone(), PathBuf::new())
    } else {
        let parent = path.parent().expect("filesystem roots handled above");
        (parent.to_path_buf(), path.file_name().map(PathBuf::from).unwrap_or_default())
    };
    let text = matches!(&kind, LocalPathKind::File) && {
        use std::io::Read;
        let mut sample = [0_u8; 8192];
        std::fs::File::open(&path)
            .and_then(|mut file| file.read(&mut sample))
            .map(|read| {
                let bytes = &sample[..read];
                !bytes.contains(&0)
                    && std::str::from_utf8(bytes)
                        .map(|_| true)
                        // A multibyte source character may cross the sample boundary.
                        .unwrap_or_else(|error| {
                            error.error_len().is_none() && read == sample.len() && metadata.len() > read as u64
                        })
            })
            .unwrap_or(false)
    };
    Ok(LocalPathInfo {
        path: path.to_string_lossy().into_owned(),
        root: root.to_string_lossy().into_owned(),
        rel: rel.to_string_lossy().replace('\\', "/"),
        kind,
        text,
    })
}

/// The native system opener accepts only a canonical target that currently
/// exists and is a regular file or folder. It never accepts a program name.
pub fn existing_local_path(candidate: &Path) -> Result<PathBuf> {
    let path = candidate
        .canonicalize()
        .map_err(|error| anyhow::anyhow!("Destination {} is unavailable: {error}", candidate.display()))?;
    let metadata = path.metadata()?;
    anyhow::ensure!(metadata.is_file() || metadata.is_dir(), "Destination {} is not a regular file or folder", path.display());
    Ok(path)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHit {
    pub path: String,
    pub line: u32,
    /// Character column of the first match on the line.
    pub col: u32,
    pub text: String,
    /// Every match on the line as `[start, end)` character offsets into `text`.
    pub matches: Vec<(u32, u32)>,
    /// What each match becomes when a replacement was asked for, in the same order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacements: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearch {
    pub hits: Vec<TextHit>,
    pub files: usize,
    pub capped: bool,
}

/// Files a replacement should touch: a path, and the 1-based lines to change
/// in it, or every line when `lines` is absent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: String,
    pub lines: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    pub files: usize,
    pub replacements: usize,
}

/// How much of a line to ship back with a hit.
const SHOWN_CHARS: usize = 400;

fn text_pattern(query: &str, regex: bool, case_sensitive: bool, whole_word: bool) -> Result<regex::Regex> {
    let pattern = if regex {
        query.to_string()
    } else if whole_word {
        // A literal needs a boundary only on a side that ends in a word
        // character, so `foo(` still matches the start of `foo(x)`.
        let edge = |c: Option<char>| if c.is_some_and(is_word_char) { r"\b" } else { "" };
        format!("{}{}{}", edge(query.chars().next()), regex::escape(query), edge(query.chars().last()))
    } else {
        regex::escape(query)
    };
    Ok(regex::RegexBuilder::new(&pattern).case_insensitive(!case_sensitive).build()?)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether `line[start..end]` stands as a whole word: neither edge cuts
/// through a run of word characters, the rule the editor's find uses.
fn whole_word_at(line: &str, start: usize, end: usize) -> bool {
    let cuts = |before: Option<char>, after: Option<char>| before.is_some_and(is_word_char) && after.is_some_and(is_word_char);
    !cuts(line[..start].chars().next_back(), line[start..].chars().next()) && !cuts(line[..end].chars().next_back(), line[end..].chars().next())
}

/// Every regular file under `root` that a text search should read: the
/// `.gitignore`d, the hidden, and the build trees are left out.
fn text_files(root: &Path) -> impl Iterator<Item = ignore::DirEntry> {
    ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name == ".git" || name == "node_modules" || name == "target" || name == ".raccoon")
        })
        .build()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
}

fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

/// The bytes of a file worth searching: small enough, and not binary.
fn searchable_bytes(path: &Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > MAX_TEXT as usize || bytes.iter().take(8192).any(|&b| b == 0) {
        return None;
    }
    Some(bytes)
}

/// Replacement templates are written the way editors expect them: `$1`, `$&`
/// for the whole match, `$<name>`, and `$$` for a dollar sign. The regex
/// crate reads `$1abc` as a group called `1abc` and knows no `$&`, so those
/// forms are rewritten into its braced syntax before expansion.
fn normalize_replacement(template: &str) -> String {
    let mut out = String::with_capacity(template.len() + 8);
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('$') => {
                chars.next();
                out.push_str("$$");
            }
            Some('&') => {
                chars.next();
                out.push_str("${0}");
            }
            Some('<') => {
                chars.next();
                let mut name = String::new();
                let mut closed = false;
                for n in chars.by_ref() {
                    if n == '>' {
                        closed = true;
                        break;
                    }
                    name.push(n);
                }
                if closed && !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    out.push_str(&format!("${{{name}}}"));
                } else {
                    out.push_str("$$<");
                    out.push_str(&name);
                    if closed {
                        out.push('>');
                    }
                }
            }
            Some(d) if d.is_ascii_digit() => {
                let mut digits = String::new();
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_digit() {
                        digits.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                out.push_str(&format!("${{{digits}}}"));
            }
            _ => out.push_str("$$"),
        }
    }
    out
}

/// A compiled query plus how each match is rewritten, shared by the search
/// preview and the replacement itself so what is shown is what is written.
struct Rewriter {
    re: regex::Regex,
    template: Option<String>,
    regex: bool,
    /// A regex's matches are checked for word edges one by one; a literal
    /// carries its boundaries in the pattern.
    word_filter: bool,
}

impl Rewriter {
    fn new(query: &str, replacement: Option<&str>, regex: bool, case_sensitive: bool, whole_word: bool) -> Result<Self> {
        let re = text_pattern(query, regex, case_sensitive, whole_word)?;
        let template = replacement.map(|r| if regex { normalize_replacement(r) } else { r.to_string() });
        Ok(Self { re, template, regex, word_filter: regex && whole_word })
    }

    /// The matches in a line that count, in order.
    fn captures<'a>(&'a self, line: &'a str) -> impl Iterator<Item = regex::Captures<'a>> + 'a {
        self.re.captures_iter(line).filter(move |caps| {
            let m = caps.get(0).expect("group 0");
            !self.word_filter || (!m.is_empty() && whole_word_at(line, m.start(), m.end()))
        })
    }

    /// What one match turns into.
    fn expand(&self, caps: &regex::Captures) -> String {
        let template = self.template.as_deref().unwrap_or_default();
        if !self.regex {
            return template.to_string();
        }
        let mut out = String::new();
        caps.expand(template, &mut out);
        out
    }

    /// A line with every match rewritten, and how many there were.
    fn rewrite_line(&self, line: &str) -> (String, usize) {
        let mut out = String::with_capacity(line.len());
        let mut last = 0;
        let mut n = 0;
        for caps in self.captures(line) {
            let m = caps.get(0).expect("group 0");
            out.push_str(&line[last..m.start()]);
            out.push_str(&self.expand(&caps));
            last = m.end();
            n += 1;
        }
        out.push_str(&line[last..]);
        (out, n)
    }
}

/// Grep the tree: literal or regex, case-sensitive or not, whole words or
/// not, binary files skipped, capped by hit count so a broad query returns
/// promptly. With a replacement, each hit also carries what its matches
/// would become.
#[allow(clippy::too_many_arguments)]
pub fn search_text(root: &Path, query: &str, regex: bool, case_sensitive: bool, whole_word: bool, limit: usize, replacement: Option<&str>) -> Result<TextSearch> {
    let never = std::sync::atomic::AtomicBool::new(false);
    Ok(search_text_under(root, root, query, regex, case_sensitive, whole_word, limit, replacement, &never)?.0)
}

/// [`search_text`] over the tree at `base` (inside `root`, which hit paths
/// are relative to), stopping between files once `cancel` is set. The flag
/// says whether it stopped early.
#[allow(clippy::too_many_arguments)]
pub fn search_text_under(
    root: &Path,
    base: &Path,
    query: &str,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    limit: usize,
    replacement: Option<&str>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(TextSearch, bool)> {
    if query.is_empty() {
        return Ok((TextSearch { hits: vec![], files: 0, capped: false }, false));
    }
    let rw = Rewriter::new(query, replacement, regex, case_sensitive, whole_word)?;
    let mut hits = Vec::new();
    let mut files = 0usize;
    let mut capped = false;
    let mut cancelled = false;
    'files: for entry in text_files(base) {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let Some(bytes) = searchable_bytes(entry.path()) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let rel = rel_of(root, entry.path());
        let mut any = false;
        for (i, line) in text.lines().enumerate() {
            let Some(hit) = line_hit(&rw, &rel, i as u32 + 1, line, replacement.is_some()) else { continue };
            any = true;
            hits.push(hit);
            if hits.len() >= limit {
                capped = true;
                files += 1;
                break 'files;
            }
        }
        if any {
            files += 1;
        }
    }
    Ok((TextSearch { hits, files, capped }, cancelled))
}

/// One line's matches as character offsets (the editor addresses columns in
/// characters, the regex crate in bytes), with previews when replacing.
fn line_hit(rw: &Rewriter, rel: &str, number: u32, line: &str, preview: bool) -> Option<TextHit> {
    let mut matches = Vec::new();
    let mut replacements = Vec::new();
    // Byte → char offsets, walked forward once since matches come in order.
    let mut byte_at = 0usize;
    let mut chars_at = 0u32;
    let mut advance = |to: usize| {
        chars_at += line[byte_at..to].chars().count() as u32;
        byte_at = to;
        chars_at
    };
    for caps in rw.captures(line) {
        let m = caps.get(0).expect("group 0");
        let start = advance(m.start());
        let end = advance(m.end());
        matches.push((start, end));
        if preview {
            replacements.push(rw.expand(&caps));
        }
    }
    if matches.is_empty() {
        return None;
    }
    let shown: String = line.trim_end().chars().take(SHOWN_CHARS).collect();
    Some(TextHit {
        path: rel.to_string(),
        line: number,
        col: matches[0].0,
        text: shown,
        matches,
        replacements: preview.then_some(replacements),
    })
}

/// Rewrite matches on disk. `targets` names the files and lines to touch;
/// when absent every searchable file under `root` is a target, except the
/// paths in `skip` (open buffers the caller updates itself). Files are only
/// written when something changed, and a file that is not valid UTF-8 is
/// left alone rather than written back lossily.
#[allow(clippy::too_many_arguments)]
pub fn replace_text(
    root: &Path,
    query: &str,
    replacement: &str,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    targets: Option<Vec<ReplaceTarget>>,
    skip: &[String],
) -> Result<ReplaceReport> {
    if query.is_empty() {
        return Ok(ReplaceReport { files: 0, replacements: 0 });
    }
    let rw = Rewriter::new(query, Some(replacement), regex, case_sensitive, whole_word)?;
    let root = root.canonicalize()?;
    let jobs: Vec<(PathBuf, Option<Vec<u32>>)> = match targets {
        Some(targets) => targets
            .into_iter()
            .map(|t| {
                let abs = root.join(&t.path);
                let real = abs.canonicalize().map_err(|e| anyhow::anyhow!("{}: {e}", t.path))?;
                if !real.starts_with(&root) {
                    anyhow::bail!("{} is outside the project", t.path);
                }
                Ok((real, t.lines))
            })
            .collect::<Result<_>>()?,
        None => text_files(&root).filter(|e| !skip.iter().any(|s| s == &rel_of(&root, e.path()))).map(|e| (e.into_path(), None)).collect(),
    };
    let mut report = ReplaceReport { files: 0, replacements: 0 };
    for (path, lines) in jobs {
        let Some(bytes) = searchable_bytes(&path) else { continue };
        let Ok(text) = String::from_utf8(bytes) else { continue };
        let (next, n) = rewrite_text(&rw, &text, lines.as_deref());
        if n == 0 {
            continue;
        }
        write_text(&path, &next)?;
        report.files += 1;
        report.replacements += n;
    }
    Ok(report)
}

/// A whole file rewritten line by line so every line ending survives as it
/// was; only the numbered lines change when a filter is given.
fn rewrite_text(rw: &Rewriter, text: &str, lines: Option<&[u32]>) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut total = 0;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        let number = i as u32 + 1;
        if lines.is_some_and(|l| !l.contains(&number)) {
            out.push_str(raw);
            continue;
        }
        let body = raw.strip_suffix('\n').unwrap_or(raw);
        let (body, ending) = match body.strip_suffix('\r') {
            Some(b) => (b, &raw[b.len()..]),
            None => (body, &raw[body.len()..]),
        };
        let (rewritten, n) = rw.rewrite_line(body);
        out.push_str(&rewritten);
        out.push_str(ending);
        total += n;
    }
    (out, total)
}

#[cfg(test)]
mod tree_tests {
    use super::*;

    /// The All files filter sees what the tree shows: hidden files and
    /// folders such as node_modules unless .gitignore leaves them out.
    #[test]
    fn the_filter_list_follows_the_trees_rules_and_says_when_it_was_cut() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        for path in [".github/workflows/ci.yml", ".env.example", "node_modules/pkg/index.js", "src/main.rs", "build/out.bin", ".git/HEAD", ".raccoon/x", ".DS_Store"] {
            std::fs::create_dir_all(p.join(path).parent().unwrap()).unwrap();
            std::fs::write(p.join(path), "x").unwrap();
        }
        std::fs::write(p.join(".gitignore"), "build/\n").unwrap();
        let mut all = list_all(p, 100).unwrap();
        all.paths.sort();
        assert_eq!(all.paths, [".env.example", ".github/workflows/ci.yml", ".gitignore", "node_modules/pkg/index.js", "src/main.rs"]);
        assert!(!all.truncated);
        let cut = list_all(p, 2).unwrap();
        assert_eq!(cut.paths.len(), 2);
        assert!(cut.truncated, "a capped list says so");
        assert!(!list_all(p, 5).unwrap().truncated, "exactly the limit is complete");
    }

    #[test]
    fn lists_reads_writes_and_greps() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::create_dir_all(p.join(".git")).unwrap();
        std::fs::write(p.join("src/a.ts"), "const x = 1;\nfindMe();\n").unwrap();
        std::fs::write(p.join("b.md"), "# find me\n").unwrap();
        std::fs::write(p.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(p.join("ignored.txt"), "findme\n").unwrap();
        let top = list_dir(p, "").unwrap();
        let names: Vec<_> = top.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", ".gitignore", "b.md"]);
        let sub = list_dir(p, "src").unwrap();
        assert_eq!(sub[0].path, "src/a.ts");
        let t = read_text(&p.join("src/a.ts")).unwrap();
        assert!(!t.binary && t.content.contains("findMe"));
        let m = write_text(&p.join("src/new.ts"), "hi").unwrap();
        assert!(m > 0);
        assert_eq!(stat_mtime(&p.join("src/new.ts")), Some(m));
        let s = search_text(p, "find", false, false, false, 100, None).unwrap();
        assert_eq!(s.hits.len(), 2);
        assert!(s.hits.iter().all(|h| h.path != "ignored.txt"));
        let s = search_text(p, "find", false, true, false, 1, None).unwrap();
        assert!(s.capped && s.hits.len() == 1);
        let s = search_text(p, "f.nd.?me", true, false, false, 100, None).unwrap();
        assert_eq!(s.files, 2);
    }

    #[test]
    fn whole_word_skips_partial_hits_in_search_and_replace() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::write(p.join("a.rs"), "let id = ids + id_x + Id;\nfoo(id)\n").unwrap();
        let s = search_text(p, "id", false, false, true, 100, None).unwrap();
        let spans: Vec<_> = s.hits.iter().map(|h| (h.line, h.matches.clone())).collect();
        assert_eq!(spans, vec![(1, vec![(4, 6), (22, 24)]), (2, vec![(4, 6)])]);
        let s = search_text(p, "id", false, true, true, 100, None).unwrap();
        assert_eq!(s.hits.iter().map(|h| h.matches.len()).sum::<usize>(), 2);
        // Without the toggle every partial hit is back.
        let s = search_text(p, "id", false, false, false, 100, None).unwrap();
        assert_eq!(s.hits.iter().map(|h| h.matches.len()).sum::<usize>(), 5);
        // A literal edge that is not a word character needs no boundary.
        let s = search_text(p, "foo(", false, false, true, 100, None).unwrap();
        assert_eq!(s.hits.len(), 1);
        // A regex is checked match by match.
        let s = search_text(p, "i.", true, true, true, 100, None).unwrap();
        assert_eq!(s.hits.iter().map(|h| h.matches.len()).sum::<usize>(), 2);
        let r = replace_text(p, "id", "key", false, true, true, None, &[]).unwrap();
        assert_eq!((r.files, r.replacements), (1, 2));
        assert_eq!(std::fs::read_to_string(p.join("a.rs")).unwrap(), "let key = ids + id_x + Id;\nfoo(key)\n");
        let r = replace_text(p, "k.y", "id", true, true, true, None, &[]).unwrap();
        assert_eq!(r.replacements, 2);
    }

    #[test]
    fn link_paths_resolve_inside_and_outside_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(outside.path().join("report.pdf"), b"%PDF\0binary").unwrap();

        let inside = inspect_local_path(workspace.path(), Path::new("src/main.rs")).unwrap();
        assert_eq!(inside.kind, LocalPathKind::File);
        assert_eq!(inside.root, workspace.path().canonicalize().unwrap().to_string_lossy());
        assert_eq!(inside.rel, "src/main.rs");
        assert!(inside.text);

        let external = inspect_local_path(workspace.path(), &outside.path().join("report.pdf")).unwrap();
        assert_eq!(external.root, outside.path().canonicalize().unwrap().to_string_lossy());
        assert_eq!(external.rel, "report.pdf");
        assert!(!external.text);
        assert_eq!(inspect_local_path(workspace.path(), outside.path()).unwrap().kind, LocalPathKind::Directory);
        let filesystem_root = workspace.path().canonicalize().unwrap().ancestors().last().unwrap().to_path_buf();
        let root_folder = inspect_local_path(workspace.path(), &filesystem_root).unwrap();
        assert_eq!(root_folder.kind, LocalPathKind::Directory);
        assert_eq!(root_folder.path, filesystem_root.to_string_lossy());
        assert!(inspect_local_path(workspace.path(), Path::new("missing.txt")).unwrap_err().to_string().contains("unavailable"));

        let mut boundary = vec![b'a'; 8191];
        boundary.extend_from_slice("é".as_bytes());
        std::fs::write(workspace.path().join("boundary.txt"), boundary).unwrap();
        assert!(inspect_local_path(workspace.path(), Path::new("boundary.txt")).unwrap().text);

        std::fs::write(workspace.path().join("invalid.txt"), [b'a', 0xc3, b'(']).unwrap();
        assert!(!inspect_local_path(workspace.path(), Path::new("invalid.txt")).unwrap().text);
        std::fs::write(workspace.path().join("incomplete.txt"), [b'a', 0xc3]).unwrap();
        assert!(!inspect_local_path(workspace.path(), Path::new("incomplete.txt")).unwrap().text);
        assert_eq!(existing_local_path(&workspace.path().join("src/main.rs")).unwrap(), workspace.path().canonicalize().unwrap().join("src/main.rs"));
        assert!(existing_local_path(&workspace.path().join("not-there")).is_err());
    }

    #[test]
    fn hits_carry_every_match_and_its_preview() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::write(p.join("a.txt"), "héllo foo, foo again\nnothing\nfoo\n").unwrap();
        let s = search_text(p, "foo", false, false, false, 100, Some("bar")).unwrap();
        assert_eq!(s.hits.len(), 2);
        // Columns count characters, so the accent before the first match is one column wide.
        assert_eq!(s.hits[0].col, 6);
        assert_eq!(s.hits[0].matches, vec![(6, 9), (11, 14)]);
        assert_eq!(s.hits[0].replacements.as_deref(), Some(&["bar".to_string(), "bar".to_string()][..]));
        assert_eq!(s.hits[1].line, 3);
        let s = search_text(p, "f(o+)", true, false, false, 100, Some("<$1>")).unwrap();
        assert_eq!(s.hits[0].replacements.as_deref(), Some(&["<oo>".to_string(), "<oo>".to_string()][..]));
        let s = search_text(p, "foo", false, false, false, 100, None).unwrap();
        assert!(s.hits[0].replacements.is_none());
    }

    #[test]
    fn replacement_templates_read_like_an_editor() {
        assert_eq!(normalize_replacement("$1abc"), "${1}abc");
        assert_eq!(normalize_replacement("[$&]"), "[${0}]");
        assert_eq!(normalize_replacement("$<name>!"), "${name}!");
        assert_eq!(normalize_replacement("cost: $$5"), "cost: $$5");
        assert_eq!(normalize_replacement("$ alone"), "$$ alone");
        assert_eq!(normalize_replacement("$<bad name>"), "$$<bad name>");
    }

    #[test]
    fn replaces_across_files_and_within_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::write(p.join("src/a.ts"), "foo();\nfoo(); foo();\nkeep();\n").unwrap();
        std::fs::write(p.join("b.txt"), "foo\r\nfoo\r\n").unwrap();
        std::fs::write(p.join("c.txt"), "no match here\n").unwrap();
        std::fs::write(p.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(p.join("ignored.txt"), "foo\n").unwrap();

        // Only the second line of a.ts, leaving the first alone.
        let r = replace_text(p, "foo", "bar", false, false, false, Some(vec![ReplaceTarget { path: "src/a.ts".into(), lines: Some(vec![2]) }]), &[]).unwrap();
        assert_eq!(r, ReplaceReport { files: 1, replacements: 2 });
        assert_eq!(std::fs::read_to_string(p.join("src/a.ts")).unwrap(), "foo();\nbar(); bar();\nkeep();\n");

        // The whole tree, minus a path the caller handles itself; CRLF endings survive.
        let r = replace_text(p, "foo", "baz", false, false, false, None, &["src/a.ts".to_string()]).unwrap();
        assert_eq!(r, ReplaceReport { files: 1, replacements: 2 });
        assert_eq!(std::fs::read_to_string(p.join("b.txt")).unwrap(), "baz\r\nbaz\r\n");
        assert_eq!(std::fs::read_to_string(p.join("src/a.ts")).unwrap(), "foo();\nbar(); bar();\nkeep();\n");
        assert_eq!(std::fs::read_to_string(p.join("ignored.txt")).unwrap(), "foo\n");
        // Untouched files keep their mtime: nothing was written to c.txt.
        let r = replace_text(p, "foo", "qux", false, false, false, Some(vec![ReplaceTarget { path: "c.txt".into(), lines: None }]), &[]).unwrap();
        assert_eq!(r, ReplaceReport { files: 0, replacements: 0 });

        // Regex with a capture group and a literal replacement that looks like one.
        let r = replace_text(p, "(ba)([rz])", "$2$1", true, false, false, None, &[]).unwrap();
        assert_eq!(r, ReplaceReport { files: 2, replacements: 4 });
        assert_eq!(std::fs::read_to_string(p.join("b.txt")).unwrap(), "zba\r\nzba\r\n");
        let r = replace_text(p, "zba", "$1", false, false, false, None, &[]).unwrap();
        assert_eq!(r.replacements, 2);
        assert_eq!(std::fs::read_to_string(p.join("b.txt")).unwrap(), "$1\r\n$1\r\n");

        // Paths cannot escape the root.
        let err = replace_text(p, "x", "y", false, false, false, Some(vec![ReplaceTarget { path: "../outside".into(), lines: None }]), &[]);
        assert!(err.is_err());
    }
}
