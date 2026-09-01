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
