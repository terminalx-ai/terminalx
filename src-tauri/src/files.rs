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
use serde::Serialize;

const MAX_FILES: usize = 60_000;
const FRESH_FOR: Duration = Duration::from_secs(20);

struct Index {
    built: Instant,
    files: Vec<String>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Index>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, Index>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
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
        .build();
    for entry in walker.flatten() {
        if out.len() >= MAX_FILES {
            break;
        }
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            if let Ok(rel) = entry.path().strip_prefix(root) {
                out.push(rel.to_string_lossy().into_owned());
            }
        }
    }
    out
}

fn files_for(root: &Path) -> Vec<String> {
    let mut c = cache().lock().unwrap();
    if let Some(ix) = c.get(root) {
        if ix.built.elapsed() < FRESH_FOR {
            return ix.files.clone();
        }
    }
    let files = walk(root);
    c.insert(root.to_path_buf(), Index { built: Instant::now(), files: files.clone() });
    files
}

pub fn invalidate(root: &Path) {
    cache().lock().unwrap().remove(root);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub score: u32,
}

/// Fuzzy-search the index. An empty query lists the shallowest files first,
/// which is what a bare `@` should open on.
pub fn search(root: &Path, query: &str, limit: usize) -> Result<Vec<FileHit>> {
    let files = files_for(root);
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
        let all = search(p, "", 10).unwrap();
        assert_eq!(all[0].path, "README.md");
        assert!(all.iter().all(|h| !h.path.starts_with("node_modules")));
        let hits = search(p, "button", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.path == "src/components/Button.tsx"));
        let hits = search(p, "readme", 10).unwrap();
        assert_eq!(hits[0].path, "README.md");
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub mtime_ms: u64,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(mtime_ms(&std::fs::metadata(path)?))
}

pub fn stat_mtime(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| mtime_ms(&m))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHit {
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearch {
    pub hits: Vec<TextHit>,
    pub files: usize,
    pub capped: bool,
}

/// Grep the tree: literal or regex, case-sensitive or not, binary files
/// skipped, capped by hit count so a broad query returns promptly.
pub fn search_text(root: &Path, query: &str, regex: bool, case_sensitive: bool, limit: usize) -> Result<TextSearch> {
    if query.is_empty() {
        return Ok(TextSearch { hits: vec![], files: 0, capped: false });
    }
    let pattern = if regex { query.to_string() } else { regex::escape(query) };
    let re = regex::RegexBuilder::new(&pattern).case_insensitive(!case_sensitive).build()?;
    let mut hits = Vec::new();
    let mut files = 0usize;
    let mut capped = false;
    let walker = ignore::WalkBuilder::new(root)
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
        .build();
    'files: for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else { continue };
        if bytes.len() > MAX_TEXT as usize || bytes.iter().take(8192).any(|&b| b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let rel = entry.path().strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let mut any = false;
        for (i, line) in text.lines().enumerate() {
            if let Some(m) = re.find(line) {
                any = true;
                let col = line[..m.start()].chars().count() as u32;
                let shown: String = line.trim_end().chars().take(400).collect();
                hits.push(TextHit { path: rel.clone(), line: i as u32 + 1, col, text: shown });
                if hits.len() >= limit {
                    capped = true;
                    files += 1;
                    break 'files;
                }
            }
        }
        if any {
            files += 1;
        }
    }
    Ok(TextSearch { hits, files, capped })
}

#[cfg(test)]
mod tree_tests {
    use super::*;

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
        let s = search_text(p, "find", false, false, 100).unwrap();
        assert_eq!(s.hits.len(), 2);
        assert!(s.hits.iter().all(|h| h.path != "ignored.txt"));
        let s = search_text(p, "find", false, true, 1).unwrap();
        assert!(s.capped && s.hits.len() == 1);
        let s = search_text(p, "f.nd.?me", true, false, 100).unwrap();
        assert_eq!(s.files, 2);
    }
}
