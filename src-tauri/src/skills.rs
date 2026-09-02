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

pub const RACCOON_CLI_GUIDE: &str = include_str!("../../docs/skills/raccoon-cli.md");
pub const RACCOON_CLI_STUB: &str = include_str!("../../skills/raccoon-cli/SKILL.md");

/// Append-only: installed discovery stubs can outlive a topic rename.
pub const GUIDE_ALIASES: &[(&str, &str)] = &[("raccoon-cli", "raccoon-cli")];
/// Append-only: every topic that has shipped as an installable stub.
pub const STUB_TOPICS: &[&str] = &["raccoon-cli"];

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledPlacement {
    pub agent: String,
    pub path: String,
    pub outcome: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledInstallResult {
    pub canonical_path: String,
    pub placements: Vec<BundledPlacement>,
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
    let text = read_capped(path, SKILL_FILE_LIMIT)?;
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return Err(anyhow!("{} has no YAML frontmatter", path.display()));
    }
    let mut yaml = Vec::new();
    let mut closed = false;
    for line in lines {
        if line == "---" {
            closed = true;
            break;
        }
        yaml.push(line);
    }
    if !closed {
        return Err(anyhow!("{} has unclosed YAML frontmatter", path.display()));
    }
    let frontmatter: Frontmatter = serde_yaml::from_str(&yaml.join("\n"))
        .with_context(|| format!("parse frontmatter in {}", path.display()))?;
    if frontmatter.name.trim().is_empty() || frontmatter.description.trim().is_empty() {
        return Err(anyhow!("{} needs name and description", path.display()));
    }
    Ok((frontmatter, text))
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

fn plugin_roots(home: &Path, project: Option<&Path>) -> Vec<RootSpec> {
    let mut enabled = HashMap::new();
    #[cfg(target_os = "macos")]
    merge_enabled_plugins(
        Path::new("/Library/Application Support/ClaudeCode/managed-settings.json"),
        &mut enabled,
    );
    merge_enabled_plugins(&home.join(".claude/settings.json"), &mut enabled);
    merge_enabled_plugins(&home.join(".claude/settings.local.json"), &mut enabled);
    if let Some(project) = project {
        merge_enabled_plugins(&project.join(".claude/settings.json"), &mut enabled);
        merge_enabled_plugins(&project.join(".claude/settings.local.json"), &mut enabled);
    }

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

fn folder_has_executables(path: &Path) -> bool {
    fn walk(path: &Path, seen: &mut usize) -> bool {
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
            let metadata = entry.metadata().ok();
            if metadata.as_ref().is_some_and(is_executable) {
                return true;
            }
            if kind.is_dir() && !kind.is_symlink() && walk(&entry.path(), seen) {
                return true;
            }
        }
        false
    }
    walk(path, &mut 0)
}

fn found_skill(
    dir: &Path,
    root: &RootSpec,
    home: &Path,
    source: SkillSource,
    source_label: String,
    root_path: &Path,
) -> Result<FoundSkill> {
    let canonical_dir =
        fs::canonicalize(dir).with_context(|| format!("resolve {}", dir.display()))?;
    let skill_file = canonical_dir.join("SKILL.md");
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
        let kind = entry.file_type()?;
        let metadata = entry.metadata()?;
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

pub fn detail(dir: &Path) -> Result<SkillDetail> {
    let dir = fs::canonicalize(dir).with_context(|| format!("resolve {}", dir.display()))?;
    let (_, markdown) = parse_frontmatter(&dir.join("SKILL.md"))?;
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

fn guide(topic: &str) -> Option<&'static str> {
    let canonical = GUIDE_ALIASES
        .iter()
        .find_map(|(alias, canonical)| (*alias == topic).then_some(*canonical))?;
    match canonical {
        "raccoon-cli" => Some(RACCOON_CLI_GUIDE),
        _ => None,
    }
}

fn transcript_tail(session_id: &str, tab_id: &str, limit: usize) -> Result<String> {
    let path = crate::store::log_path(session_id, tab_id)?;
    let rows = crate::store::read_lines::<Value>(&path)?;
    let start = rows.len().saturating_sub(limit.min(500));
    serde_json::to_string_pretty(&rows[start..]).map_err(Into::into)
}

fn dispatch_cli(args: &[String]) -> Result<Option<String>> {
    match args {
        [command, action, topic] if command == "skills" && action == "get" => guide(topic)
            .map(|text| Some(text.to_string()))
            .ok_or_else(|| anyhow!("unknown skill guide: {topic}")),
        [command, action] if command == "sessions" && action == "list" => Ok(Some(
            serde_json::to_string_pretty(&crate::store::index::load()?)?,
        )),
        [command, action, session, tab] if command == "transcript" && action == "tail" => {
            transcript_tail(session, tab, 80).map(Some)
        }
        [command, action, session, tab, flag, limit]
            if command == "transcript" && action == "tail" && flag == "--limit" =>
        {
            let limit = limit.parse::<usize>().context("--limit must be a number")?;
            transcript_tail(session, tab, limit).map(Some)
        }
        [command, ..]
            if command == "skills" || command == "sessions" || command == "transcript" =>
        {
            Err(anyhow!(
                "unknown Raccoon CLI command; run `raccoon skills get raccoon-cli`"
            ))
        }
        _ => Ok(None),
    }
}

/// Answer the small command surface before Tauri starts. Unknown commands in
/// this namespace fail closed instead of opening the desktop application.
pub fn run_cli() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match dispatch_cli(&args) {
        Ok(Some(output)) => {
            println!("{output}");
            true
        }
        Ok(None) => false,
        Err(error) => {
            eprintln!("{error:#}");
            std::process::exit(2);
        }
    }
}

fn relative_path(from: &Path, to: &Path) -> Result<PathBuf> {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    if common == 0 {
        return Err(anyhow!("paths have no common root"));
    }
    let mut path = PathBuf::new();
    for _ in common..from.len() {
        path.push("..");
    }
    for component in &to[common..] {
        path.push(component.as_os_str());
    }
    Ok(path)
}

fn place_bundled_skill(agent: &str, root: &Path, canonical: &Path) -> Result<BundledPlacement> {
    let destination = root.join("raccoon-cli");
    if fs::symlink_metadata(&destination).is_ok() {
        let same = fs::canonicalize(&destination).is_ok_and(|path| path == canonical);
        return Ok(BundledPlacement {
            agent: agent.into(),
            path: destination.to_string_lossy().into_owned(),
            outcome: if same {
                "alreadyInstalled"
            } else {
                "keptLocal"
            }
            .into(),
        });
    }
    crate::store::ensure_dir(root.to_path_buf())?;
    // `/var` is a link to `/private/var` on macOS. Compute from the physical
    // parent so the relative link survives that alias as well as ordinary
    // user-home paths.
    let physical_root = fs::canonicalize(root)?;
    let target = relative_path(&physical_root, canonical)?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &destination)
        .with_context(|| format!("link {} to {}", destination.display(), target.display()))?;
    #[cfg(not(unix))]
    {
        fs::create_dir_all(&destination)?;
        fs::copy(canonical.join("SKILL.md"), destination.join("SKILL.md"))?;
    }
    Ok(BundledPlacement {
        agent: agent.into(),
        path: destination.to_string_lossy().into_owned(),
        outcome: "installed".into(),
    })
}

fn install_bundled_at(
    app_home: &Path,
    user_home: &Path,
    agents: &[String],
) -> Result<BundledInstallResult> {
    if agents.is_empty()
        || agents
            .iter()
            .any(|agent| agent != "claude" && agent != "codex")
    {
        return Err(anyhow!("choose Claude, Codex, or both"));
    }
    let canonical = app_home.join("skills/bundled/raccoon-cli");
    crate::store::ensure_dir(canonical.clone())?;
    let canonical = fs::canonicalize(canonical)?;
    crate::store::write_atomic(&canonical.join("SKILL.md"), RACCOON_CLI_STUB.as_bytes())?;
    let mut placements = Vec::new();
    for agent in ["claude", "codex"] {
        if !agents.iter().any(|selected| selected == agent) {
            continue;
        }
        let root = user_home.join(format!(".{agent}/skills"));
        placements.push(place_bundled_skill(agent, &root, &canonical)?);
    }
    Ok(BundledInstallResult {
        canonical_path: canonical.to_string_lossy().into_owned(),
        placements,
    })
}

pub fn install_bundled(agents: &[String]) -> Result<BundledInstallResult> {
    let app_home = crate::store::root()?;
    let user_home = dirs::home_dir().context("no home directory")?;
    install_bundled_at(&app_home, &user_home, agents)
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
    fn bundled_stub_stays_thin_and_fetches_the_embedded_guide() {
        assert!(RACCOON_CLI_STUB.lines().count() < 40);
        assert!(RACCOON_CLI_STUB.contains("raccoon skills get raccoon-cli"));
        assert_eq!(STUB_TOPICS, ["raccoon-cli"]);
        let output = dispatch_cli(&["skills".into(), "get".into(), "raccoon-cli".into()])
            .unwrap()
            .unwrap();
        assert_eq!(output, RACCOON_CLI_GUIDE);
    }

    #[cfg(unix)]
    #[test]
    fn bundled_install_uses_one_copy_and_relative_links_without_overwriting() {
        let app = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let agents = vec!["claude".into(), "codex".into()];
        let installed = install_bundled_at(app.path(), user.path(), &agents).unwrap();
        assert_eq!(installed.placements.len(), 2);
        let canonical = PathBuf::from(&installed.canonical_path);
        for placement in &installed.placements {
            let path = PathBuf::from(&placement.path);
            assert_eq!(placement.outcome, "installed");
            assert!(fs::read_link(&path).unwrap().is_relative());
            assert_eq!(fs::canonicalize(path).unwrap(), canonical);
        }

        let claude = user.path().join(".claude/skills/raccoon-cli");
        fs::remove_file(&claude).unwrap();
        fs::create_dir(&claude).unwrap();
        fs::write(claude.join("SKILL.md"), "mine").unwrap();
        let retried = install_bundled_at(app.path(), user.path(), &["claude".into()]).unwrap();
        assert_eq!(retried.placements[0].outcome, "keptLocal");
        assert_eq!(fs::read_to_string(claude.join("SKILL.md")).unwrap(), "mine");
    }
}
