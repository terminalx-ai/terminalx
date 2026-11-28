//! Skills are folders on disk, not a runtime owned by Raccoon.
//!
//! Discovery scans only the roots the two offered agents document. A short
//! cache keeps opening the view cheap, and a failed scan retains the last good
//! contents briefly so a slow volume does not make installed skills blink.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const SKILL_FILE_LIMIT: u64 = 256 * 1024;
const PLUGIN_METADATA_LIMIT: u64 = 4 * 1024 * 1024;
const SCAN_TTL: Duration = Duration::from_secs(10);
const LAST_KNOWN_RETENTION: Duration = Duration::from_secs(5 * 60);
const MAX_CACHED_ROOTS: usize = 1024;
const MAX_DETAIL_ENTRIES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Personal,
    Repo,
    Plugin,
    Bundled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub name: String,
    pub description: String,
    pub dir_path: String,
    pub skill_file_path: String,
    pub source: SkillSource,
    pub source_label: String,
    pub roots: Vec<String>,
    pub agents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
    pub updated_at: String,
    pub has_executables: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub markdown: String,
    pub files: Vec<SkillFile>,
    pub executable_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RootSpec {
    path: PathBuf,
    source: SkillSource,
    source_label: String,
    agents: Vec<String>,
}

#[derive(Debug, Clone)]
struct FoundSkill {
    canonical_dir: PathBuf,
    row: DiscoveredSkill,
}

#[derive(Debug, Clone)]
struct CachedRoot {
    attempted_at: Instant,
    succeeded_at: Instant,
    skills: Vec<FoundSkill>,
}

#[derive(Default)]
struct ScanCache {
    roots: HashMap<PathBuf, CachedRoot>,
}

fn cache() -> &'static Mutex<ScanCache> {
    static CACHE: OnceLock<Mutex<ScanCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ScanCache::default()))
}

#[derive(Deserialize)]
struct Frontmatter {
    name: String,
    description: String,
}

fn read_capped(path: &Path, limit: u64) -> Result<String> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    if file.metadata()?.len() > limit {
        return Err(anyhow!("{} is larger than {} bytes", path.display(), limit));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(anyhow!("{} is larger than {} bytes", path.display(), limit));
    }
    String::from_utf8(bytes).with_context(|| format!("{} is not UTF-8", path.display()))
}

fn parse_frontmatter(path: &Path) -> Result<(Frontmatter, String)> {
    let text = read_capped(path, SKILL_FILE_LIMIT)?.replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else {
        return Err(anyhow!("{} has no YAML frontmatter", path.display()));
    };
    let Some(end) = rest.find("\n---\n") else {
        return Err(anyhow!("{} has unclosed YAML frontmatter", path.display()));
    };
    let frontmatter: Frontmatter = serde_yaml::from_str(&rest[..end])
        .with_context(|| format!("parse frontmatter in {}", path.display()))?;
    if frontmatter.name.trim().is_empty() || frontmatter.description.trim().is_empty() {
        return Err(anyhow!("{} needs name and description", path.display()));
    }
    Ok((frontmatter, rest[end + "\n---\n".len()..].to_string()))
}

fn pretty_path(path: &Path, home: &Path) -> String {
    path.strip_prefix(home)
        .ok()
        .map(|relative| format!("~/{}", relative.to_string_lossy()))
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn fixed_roots(home: &Path, project: Option<&Path>) -> Vec<RootSpec> {
    let mut roots = vec![
        RootSpec {
            path: home.join(".claude/skills"),
            source: SkillSource::Personal,
            source_label: "~/.claude/skills".into(),
            agents: vec!["claude".into()],
        },
        RootSpec {
            path: home.join(".codex/skills"),
            source: SkillSource::Personal,
            source_label: "~/.codex/skills".into(),
            agents: vec!["codex".into()],
        },
        RootSpec {
            path: home.join(".agents/skills"),
            source: SkillSource::Personal,
            source_label: "~/.agents/skills".into(),
            agents: vec!["claude".into(), "codex".into()],
        },
    ];
    if let Some(project) = project {
        roots.extend([
            RootSpec {
                path: project.join(".claude/skills"),
                source: SkillSource::Repo,
                source_label: ".claude/skills".into(),
                agents: vec!["claude".into()],
            },
            RootSpec {
                path: project.join(".agents/skills"),
                source: SkillSource::Repo,
                source_label: ".agents/skills".into(),
                agents: vec!["claude".into(), "codex".into()],
            },
        ]);
    }
    roots
}

fn read_json_limited(path: &Path) -> Result<Value> {
    let text = read_capped(path, PLUGIN_METADATA_LIMIT)?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn merge_enabled_plugins(path: &Path, enabled: &mut HashMap<String, bool>) {
    let Ok(settings) = read_json_limited(path) else {
        return;
    };
    let Some(entries) = settings.get("enabledPlugins").and_then(Value::as_object) else {
        return;
    };
    for (name, value) in entries {
        if let Some(on) = value.as_bool() {
            enabled.insert(name.clone(), on);
        }
    }
}

fn managed_settings_path() -> Option<&'static Path> {
    #[cfg(target_os = "macos")]
    {
        Some(Path::new("/Library/Application Support/ClaudeCode/managed-settings.json"))
    }
    #[cfg(target_os = "linux")]
    {
        Some(Path::new("/etc/claude-code/managed-settings.json"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

fn resolve_enabled_plugins(
    managed_path: Option<&Path>,
    home: &Path,
    project: Option<&Path>,
) -> HashMap<String, bool> {
    let mut enabled = HashMap::new();
    merge_enabled_plugins(&home.join(".claude/settings.json"), &mut enabled);
    merge_enabled_plugins(&home.join(".claude/settings.local.json"), &mut enabled);
    if let Some(project) = project {
        merge_enabled_plugins(&project.join(".claude/settings.json"), &mut enabled);
        merge_enabled_plugins(&project.join(".claude/settings.local.json"), &mut enabled);
    }
    // Managed policy takes highest precedence so untrusted repo or user settings
    // cannot re-enable plugins disabled by managed configuration (S-41).
    if let Some(managed) = managed_path {
        merge_enabled_plugins(managed, &mut enabled);
    }
    enabled
}

fn plugin_roots_with_managed(
    managed_path: Option<&Path>,
    home: &Path,
    project: Option<&Path>,
) -> Vec<RootSpec> {
    let enabled = resolve_enabled_plugins(managed_path, home, project);

    let manifest = home.join(".claude/plugins/installed_plugins.json");
    let Ok(value) = read_json_limited(&manifest) else {
        return Vec::new();
    };
    let Some(plugins) = value.get("plugins").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for (id, installs) in plugins {
        if enabled.get(id).is_some_and(|on| !on) {
            continue;
        }
        let label = id.split('@').next().unwrap_or(id).to_string();
        for install in installs.as_array().into_iter().flatten() {
            let Some(path) = install.get("installPath").and_then(Value::as_str) else {
                continue;
            };
            let path = PathBuf::from(path).join("skills");
            if seen.insert(path.clone()) {
                roots.push(RootSpec {
                    source_label: label.clone(),
                    path,
                    source: SkillSource::Plugin,
                    agents: vec!["claude".into()],
                });
            }
        }
    }
    roots
}

fn plugin_roots(home: &Path, project: Option<&Path>) -> Vec<RootSpec> {
    plugin_roots_with_managed(managed_settings_path(), home, project)
}

fn is_executable(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}

fn canonical_within(candidate: &Path, root: &Path) -> Result<PathBuf> {
    let canonical_root = crate::paths::canonicalize(root)
        .with_context(|| format!("resolve {}", root.display()))?;
    let canonical = crate::paths::canonicalize(candidate)
        .with_context(|| format!("resolve {}", candidate.display()))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(anyhow!(
            "{} escapes root {}",
            candidate.display(),
            root.display()
        ));
    }
    Ok(canonical)
}

fn folder_has_executables(root: &Path) -> bool {
    fn walk(root: &Path, path: &Path, seen: &mut usize) -> bool {
        let Ok(entries) = fs::read_dir(path) else {
            return false;
        };
        for entry in entries.flatten() {
            *seen += 1;
            if *seen > MAX_DETAIL_ENTRIES {
                return false;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let entry_path = entry.path();
            if kind.is_symlink() {
                // Never inspect symlink targets outside the skill directory (S-41).
                if canonical_within(&entry_path, root).is_err() {
                    continue;
                }
            }
            let metadata = entry.metadata().ok();
            if metadata.as_ref().is_some_and(is_executable) {
                return true;
            }
            if kind.is_dir() && !kind.is_symlink() && walk(root, &entry_path, seen) {
                return true;
            }
        }
        false
    }
    walk(root, root, &mut 0)
}

fn found_skill(
    dir: &Path,
    root: &RootSpec,
    home: &Path,
    source: SkillSource,
    source_label: String,
    root_path: &Path,
) -> Result<FoundSkill> {
    let canonical_dir = if source == SkillSource::Repo {
        // Untrusted repository skill directories must not symlink outside the repo skill root (S-41).
        let canonical = canonical_within(dir, root_path)?;
        let canonical_root = crate::paths::canonicalize(root_path)
            .with_context(|| format!("resolve {}", root_path.display()))?;
        if canonical == canonical_root {
            return Err(anyhow!("{} is not a skill subdirectory", dir.display()));
        }
        canonical
    } else {
        crate::paths::canonicalize(dir).with_context(|| format!("resolve {}", dir.display()))?
    };
    let skill_file = canonical_within(&canonical_dir.join("SKILL.md"), &canonical_dir)?;
    let (frontmatter, _) = parse_frontmatter(&skill_file)?;
    let updated = skill_file
        .metadata()
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let updated_at: DateTime<Utc> = updated.into();
    Ok(FoundSkill {
        canonical_dir: canonical_dir.clone(),
        row: DiscoveredSkill {
            name: frontmatter.name.trim().to_string(),
            description: frontmatter.description.trim().to_string(),
            dir_path: canonical_dir.to_string_lossy().into_owned(),
            skill_file_path: skill_file.to_string_lossy().into_owned(),
            source,
            source_label,
            roots: vec![pretty_path(root_path, home)],
            agents: root.agents.clone(),
            install_id: None,
            updated_at: updated_at.to_rfc3339(),
            has_executables: folder_has_executables(&canonical_dir),
        },
    })
}

fn scan_root(root: &RootSpec, home: &Path) -> Result<Vec<FoundSkill>> {
    let entries =
        fs::read_dir(&root.path).with_context(|| format!("scan {}", root.path.display()))?;
    let mut found = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                log::warn!("skill entry in {}: {error}", root.path.display());
                continue;
            }
        };
        if entry.file_name() == ".system" && root.source == SkillSource::Personal {
            let system_root = entry.path();
            let Ok(bundled) = fs::read_dir(&system_root) else {
                continue;
            };
            for bundled_entry in bundled.flatten() {
                match found_skill(
                    &bundled_entry.path(),
                    root,
                    home,
                    SkillSource::Bundled,
                    "Codex".into(),
                    &system_root,
                ) {
                    Ok(skill) => found.push(skill),
                    Err(error) => log::debug!("skipping bundled skill: {error:#}"),
                }
            }
            continue;
        }
        match found_skill(
            &entry.path(),
            root,
            home,
            root.source,
            root.source_label.clone(),
            &root.path,
        ) {
            Ok(skill) => found.push(skill),
            Err(error) => log::debug!("skipping skill: {error:#}"),
        }
    }
    Ok(found)
}

fn cached_scan(
    root: &RootSpec,
    home: &Path,
    refresh: bool,
    now: Instant,
    cache: &mut ScanCache,
) -> Vec<FoundSkill> {
    if !refresh {
        if let Some(entry) = cache.roots.get(&root.path) {
            if now.duration_since(entry.attempted_at) < SCAN_TTL {
                return entry.skills.clone();
            }
        }
    }
    match scan_root(root, home) {
        Ok(skills) => {
            cache.roots.insert(
                root.path.clone(),
                CachedRoot {
                    attempted_at: now,
                    succeeded_at: now,
                    skills: skills.clone(),
                },
            );
            if cache.roots.len() > MAX_CACHED_ROOTS {
                if let Some(oldest) = cache
                    .roots
                    .iter()
                    .min_by_key(|(_, entry)| entry.attempted_at)
                    .map(|(path, _)| path.clone())
                {
                    cache.roots.remove(&oldest);
                }
            }
            skills
        }
        Err(error) => {
            log::debug!("skill root unavailable: {error:#}");
            if let Some(entry) = cache.roots.get_mut(&root.path) {
                entry.attempted_at = now;
                if now.duration_since(entry.succeeded_at) < LAST_KNOWN_RETENTION {
                    return entry.skills.clone();
                }
            }
            cache.roots.remove(&root.path);
            Vec::new()
        }
    }
}

fn source_priority(source: SkillSource) -> u8 {
    match source {
        SkillSource::Repo => 4,
        SkillSource::Personal => 3,
        SkillSource::Plugin => 2,
        SkillSource::Bundled => 1,
    }
}

fn deduplicate(found: Vec<FoundSkill>) -> Vec<DiscoveredSkill> {
    let mut rows: Vec<FoundSkill> = Vec::new();
    let mut by_path: HashMap<PathBuf, usize> = HashMap::new();
    for skill in found {
        if let Some(index) = by_path.get(&skill.canonical_dir).copied() {
            let existing = &mut rows[index].row;
            for agent in skill.row.agents {
                if !existing.agents.contains(&agent) {
                    existing.agents.push(agent);
                }
            }
            for root in skill.row.roots {
                if !existing.roots.contains(&root) {
                    existing.roots.push(root);
                }
            }
            if source_priority(skill.row.source) > source_priority(existing.source) {
                existing.source = skill.row.source;
                existing.source_label = skill.row.source_label;
            }
            existing.has_executables |= skill.row.has_executables;
        } else {
            by_path.insert(skill.canonical_dir.clone(), rows.len());
            rows.push(skill);
        }
    }
    let mut rows: Vec<DiscoveredSkill> = rows
        .into_iter()
        .map(|mut skill| {
            skill
                .row
                .agents
                .sort_by_key(|agent| if agent == "claude" { 0 } else { 1 });
            skill.row.roots.sort();
            skill.row
        })
        .collect();
    rows.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.dir_path.cmp(&b.dir_path))
    });
    rows
}

pub fn discover(project_path: Option<&str>, refresh: bool) -> Result<Vec<DiscoveredSkill>> {
    let home = dirs::home_dir().context("no home directory")?;
    let project = project_path
        .filter(|path| !path.trim().is_empty())
        .map(Path::new);
    let mut roots = fixed_roots(&home, project);
    roots.extend(plugin_roots(&home, project));
    let now = Instant::now();
    let mut cache = cache().lock().unwrap_or_else(|error| error.into_inner());
    let mut found = Vec::new();
    for root in &roots {
        found.extend(cached_scan(root, &home, refresh, now, &mut cache));
    }
    Ok(deduplicate(found))
}

fn collect_files(dir: &Path, relative: &Path, out: &mut Vec<SkillFile>) -> Result<()> {
    if out.len() >= MAX_DETAIL_ENTRIES {
        return Ok(());
    }
    let current = dir.join(relative);
    let mut entries: Vec<_> = fs::read_dir(&current)
        .with_context(|| format!("scan {}", current.display()))?
        .filter_map(std::result::Result::ok)
        .collect();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    for entry in entries {
        if out.len() >= MAX_DETAIL_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = relative.join(&name);
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() && canonical_within(&entry.path(), dir).is_err() {
            // Skip symlinks pointing outside the skill folder (S-41).
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let is_dir = metadata.is_dir();
        out.push(SkillFile {
            path: path.to_string_lossy().replace('\\', "/"),
            name,
            is_dir,
            executable: is_executable(&metadata),
        });
        if is_dir && !kind.is_symlink() {
            collect_files(dir, &path, out)?;
        }
    }
    Ok(())
}

fn authorized_skill_roots(home: &Path) -> Vec<RootSpec> {
    let mut roots = fixed_roots(home, None);
    roots.extend(plugin_roots(home, None));
    if let Ok((projects, _)) = crate::store::projects::list() {
        for project in projects {
            let project_path = Path::new(&project.path);
            roots.extend(fixed_roots(home, Some(project_path)));
            roots.extend(plugin_roots(home, Some(project_path)));
        }
    }
    roots
}

fn is_authorized_skill_dir(canonical_dir: &Path, roots: &[RootSpec], cached_dirs: &[PathBuf]) -> bool {
    if cached_dirs.iter().any(|dir| dir == canonical_dir) {
        return true;
    }
    for root in roots {
        if let Ok(canonical_root) = crate::paths::canonicalize(&root.path) {
            if canonical_dir != canonical_root && canonical_dir.starts_with(&canonical_root) {
                return true;
            }
        }
    }
    false
}

fn detail_authorized(dir: &Path, roots: &[RootSpec], cached_dirs: &[PathBuf]) -> Result<SkillDetail> {
    let dir = crate::paths::canonicalize(dir).with_context(|| format!("resolve {}", dir.display()))?;
    if !is_authorized_skill_dir(&dir, roots, cached_dirs) {
        return Err(anyhow!(
            "refusing to inspect {}: path is outside authorized skill roots",
            dir.display()
        ));
    }
    let skill_file = canonical_within(&dir.join("SKILL.md"), &dir)?;
    let (_, markdown) = parse_frontmatter(&skill_file)?;
    let mut files = Vec::new();
    collect_files(&dir, Path::new(""), &mut files)?;
    let executable_files = files
        .iter()
        .filter(|file| file.executable)
        .map(|file| file.path.clone())
        .collect();
    Ok(SkillDetail {
        markdown,
        files,
        executable_files,
    })
}

pub fn detail(dir: &Path) -> Result<SkillDetail> {
    let home = dirs::home_dir().context("no home directory")?;
    let cached_dirs: Vec<PathBuf> = {
        let guard = cache().lock().unwrap_or_else(|error| error.into_inner());
        guard
            .roots
            .values()
            .flat_map(|entry| entry.skills.iter().map(|skill| skill.canonical_dir.clone()))
            .collect()
    };
    let roots = authorized_skill_roots(&home);
    detail_authorized(dir, &roots, &cached_dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn skill(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: >-\n  {description}\n---\n\n# {name}\n"),
        )
        .unwrap();
    }

    #[test]
    fn parses_yaml_frontmatter_and_rejects_missing_or_oversized_files() {
        let temp = tempfile::tempdir().unwrap();
        let good = temp.path().join("good.md");
        fs::write(
            &good,
            "---\nname: demo\ndescription: >-\n  A folded\n  description.\n---\nbody",
        )
        .unwrap();
        let (frontmatter, text) = parse_frontmatter(&good).unwrap();
        assert_eq!(frontmatter.name, "demo");
        assert_eq!(frontmatter.description, "A folded description.");
        assert!(text.ends_with("body"));
        assert!(parse_frontmatter(&temp.path().join("missing.md")).is_err());

        let large = temp.path().join("large.md");
        let mut file = File::create(&large).unwrap();
        file.write_all(&vec![b'x'; SKILL_FILE_LIMIT as usize + 1])
            .unwrap();
        assert!(parse_frontmatter(&large).is_err());
    }

    #[test]
    fn root_table_names_the_two_agents_and_repo_scope() {
        let home = Path::new("/home/reader");
        let project = Path::new("/code/project");
        let roots = fixed_roots(home, Some(project));
        assert_eq!(roots.len(), 5);
        assert_eq!(roots[0].path, home.join(".claude/skills"));
        assert_eq!(roots[0].agents, ["claude"]);
        assert_eq!(roots[1].path, home.join(".codex/skills"));
        assert_eq!(roots[1].agents, ["codex"]);
        assert_eq!(roots[2].agents, ["claude", "codex"]);
        assert_eq!(roots[3].source, SkillSource::Repo);
        assert_eq!(roots[4].path, project.join(".agents/skills"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_skill_is_one_row_with_every_root_and_agent() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let canonical = home.join(".agents/skills/demo");
        skill(&canonical, "demo", "One folder, two placements.");
        fs::create_dir_all(home.join(".claude/skills")).unwrap();
        symlink(&canonical, home.join(".claude/skills/demo")).unwrap();
        let roots = fixed_roots(home, None);
        let found = roots
            .iter()
            .flat_map(|root| scan_root(root, home).unwrap_or_default())
            .collect();
        let rows = deduplicate(found);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agents, ["claude", "codex"]);
        assert_eq!(rows[0].roots.len(), 2);
    }

    #[test]
    fn failed_scan_retains_last_known_but_a_successful_empty_scan_clears() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let root_path = home.join("skills");
        skill(
            &root_path.join("demo"),
            "demo",
            "Still here during a failed scan.",
        );
        let root = RootSpec {
            path: root_path.clone(),
            source: SkillSource::Personal,
            source_label: "skills".into(),
            agents: vec!["claude".into()],
        };
        let mut cache = ScanCache::default();
        let now = Instant::now();
        assert_eq!(cached_scan(&root, home, true, now, &mut cache).len(), 1);
        fs::rename(&root_path, home.join("skills-away")).unwrap();
        assert_eq!(
            cached_scan(&root, home, true, now + Duration::from_secs(1), &mut cache).len(),
            1
        );
        fs::create_dir(&root_path).unwrap();
        assert!(
            cached_scan(&root, home, true, now + Duration::from_secs(2), &mut cache).is_empty()
        );
    }

    #[test]
    fn detail_rejects_directories_outside_authorized_skill_roots() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let allowed_skill = home.join(".claude/skills/valid");
        skill(&allowed_skill, "valid", "Inside an authorized skill root.");
        let outside_dir = temp.path().join("outside");
        skill(&outside_dir, "outside", "Arbitrary host folder with a SKILL.md.");

        let roots = fixed_roots(&home, None);
        assert!(detail_authorized(&allowed_skill, &roots, &[]).is_ok());
        let err = detail_authorized(&outside_dir, &roots, &[]).unwrap_err();
        assert!(
            err.to_string().contains("outside authorized skill roots"),
            "unexpected error: {err:#}"
        );
        // The root folder itself cannot be enumerated as a skill.
        assert!(detail_authorized(&home.join(".claude/skills"), &roots, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn repo_skill_symlink_escape_and_skill_md_escape_are_rejected() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("repo");
        let outside = temp.path().join("secret");
        skill(&outside, "secret", "Outside the repo.");

        let repo_skills = project.join(".claude/skills");
        fs::create_dir_all(&repo_skills).unwrap();
        symlink(&outside, repo_skills.join("escaped-dir")).unwrap();

        let sneaky = repo_skills.join("sneaky-md");
        fs::create_dir_all(&sneaky).unwrap();
        symlink(outside.join("SKILL.md"), sneaky.join("SKILL.md")).unwrap();

        let good = repo_skills.join("legit");
        skill(&good, "legit", "Contained inside repo skill root.");
        symlink(outside.join("SKILL.md"), good.join("leaked-link.md")).unwrap();

        let repo_root = RootSpec {
            path: repo_skills,
            source: SkillSource::Repo,
            source_label: ".claude/skills".into(),
            agents: vec!["claude".into()],
        };
        let found = scan_root(&repo_root, &home).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].row.name, "legit");

        // detail_authorized must also omit symlinks pointing outside the skill dir.
        let detail = detail_authorized(&good, &[repo_root], &[]).unwrap();
        assert!(detail.files.iter().all(|f| f.name != "leaked-link.md"));
    }

    #[test]
    fn managed_disabled_plugin_cannot_be_overridden_by_repo_or_user_settings() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("repo");
        let managed = temp.path().join("managed-settings.json");

        fs::create_dir_all(home.join(".claude/plugins")).unwrap();
        fs::create_dir_all(project.join(".claude")).unwrap();

        let blocked_dir = temp.path().join("plugin-blocked");
        let allowed_dir = temp.path().join("plugin-allowed");
        fs::create_dir_all(blocked_dir.join("skills")).unwrap();
        fs::create_dir_all(allowed_dir.join("skills")).unwrap();

        fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            serde_json::json!({
                "plugins": {
                    "blocked@org": [{ "installPath": blocked_dir }],
                    "allowed@org": [{ "installPath": allowed_dir }]
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            &managed,
            r#"{"enabledPlugins": {"blocked@org": false}}"#,
        )
        .unwrap();
        // Both user and untrusted repo try to re-enable the managed-disabled plugin.
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"enabledPlugins": {"blocked@org": true, "allowed@org": true}}"#,
        )
        .unwrap();
        fs::write(
            project.join(".claude/settings.json"),
            r#"{"enabledPlugins": {"blocked@org": true}}"#,
        )
        .unwrap();
        fs::write(
            project.join(".claude/settings.local.json"),
            r#"{"enabledPlugins": {"blocked@org": true}}"#,
        )
        .unwrap();

        let roots = plugin_roots_with_managed(Some(&managed), &home, Some(&project));
        let labels: Vec<&str> = roots.iter().map(|r| r.source_label.as_str()).collect();
        assert_eq!(labels, vec!["allowed"]);
    }
}
