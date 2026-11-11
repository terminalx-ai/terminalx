//! What a new project starts with: the templates "Create a project" offers.
//!
//! Three ship inside the app, compiled in from `src-tauri/templates/`, so a
//! project can be made offline and every copy of a version makes the same
//! files. The reader can add their own from any folder on this computer; those
//! are kept by path in `$TERMINALX_HOME/project-templates.json` and read when a
//! project is made from them, so editing the folder changes what the next
//! project gets.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::project_start::Failure;

pub const EMPTY: &str = "empty";
pub const VITE_REACT: &str = "vite-react";
pub const AGENT_STARTER: &str = "agent-starter";

/// A user template's folder may not hold more than this; a folder that does is
/// most likely not a template (a home directory, a checkout with its build).
const USER_TEMPLATE_FILE_LIMIT: usize = 5_000;
const USER_TEMPLATE_BYTE_LIMIT: u64 = 200 * 1024 * 1024;
/// Never copied from a folder that is not a Git repository: what a Git one
/// would ignore anyway, and the folder's own history.
const SKIPPED_DIRS: [&str; 5] = [".git", "node_modules", ".venv", "target", "dist"];

/// How the project's name is written into a file, so a name with quotes or
/// angle brackets cannot break the file it lands in.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Fill {
    /// Copied byte for byte.
    None,
    /// Markdown and plain text: the name as typed.
    Text,
    /// HTML text.
    Html,
    /// Inside a double-quoted JavaScript or JSON string.
    Js,
}

struct BuiltInFile {
    /// Where it lands in the project.
    path: &'static str,
    contents: &'static str,
    fill: Fill,
    executable: bool,
}

struct BuiltIn {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    files: &'static [BuiltInFile],
}

macro_rules! file {
    ($dir:literal, $source:literal => $path:literal, $fill:expr) => {
        BuiltInFile { path: $path, contents: include_str!(concat!("../templates/", $dir, "/", $source)), fill: $fill, executable: false }
    };
    ($dir:literal, $source:literal, $fill:expr) => {
        file!($dir, $source => $source, $fill)
    };
    ($dir:literal, $source:literal, $fill:expr, executable) => {
        BuiltInFile { executable: true, ..file!($dir, $source => $source, $fill) }
    };
}

// `.gitignore` is kept as `gitignore` in this repository: under its own name
// it would apply to the template folder itself.
const BUILT_INS: [BuiltIn; 3] = [
    BuiltIn {
        id: EMPTY,
        name: "Empty",
        description: "A README, a .gitignore and nothing else",
        files: &[file!("empty", "README.md", Fill::Text), file!("empty", "gitignore" => ".gitignore", Fill::None)],
    },
    BuiltIn {
        id: VITE_REACT,
        name: "Vite + React",
        description: "TypeScript, Tailwind and Vitest",
        files: &[
            file!("vite-react", "README.md", Fill::Text),
            file!("vite-react", "gitignore" => ".gitignore", Fill::None),
            file!("vite-react", "package.json", Fill::Js),
            file!("vite-react", "index.html", Fill::Html),
            file!("vite-react", "tsconfig.json", Fill::None),
            file!("vite-react", "vite.config.ts", Fill::None),
            file!("vite-react", "src/main.tsx", Fill::None),
            file!("vite-react", "src/App.tsx", Fill::Js),
            file!("vite-react", "src/App.test.tsx", Fill::Js),
            file!("vite-react", "src/index.css", Fill::None),
            file!("vite-react", "src/test-setup.ts", Fill::None),
        ],
    },
    BuiltIn {
        id: AGENT_STARTER,
        name: "Agent starter",
        description: "CLAUDE.md, AGENTS.md, setup and test scripts",
        files: &[
            file!("agent-starter", "README.md", Fill::Text),
            file!("agent-starter", "AGENTS.md", Fill::Text),
            file!("agent-starter", "CLAUDE.md", Fill::Text),
            file!("agent-starter", "gitignore" => ".gitignore", Fill::None),
            file!("agent-starter", "scripts/setup.sh", Fill::None, executable),
            file!("agent-starter", "scripts/test.sh", Fill::None, executable),
        ],
    },
];

/// One choice in the dialog's Template row, and one row in Settings for the reader's own.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub built_in: bool,
    /// A user template's folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Why a user template cannot be used now (its folder is gone), else none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserTemplate {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UserTemplates {
    #[serde(default)]
    templates: Vec<UserTemplate>,
}

const USER_PREFIX: &str = "user:";

fn store_file() -> Result<PathBuf, Failure> {
    crate::store::root().map(|root| root.join("project-templates.json")).map_err(|error| Failure::new(crate::project_start::FAILED, format!("Could not find TerminalX's settings folder: {error}")))
}

fn read_user(file: &Path) -> Result<Vec<UserTemplate>, Failure> {
    crate::store::read_json::<UserTemplates>(file)
        .map(|found| found.unwrap_or_default().templates)
        .map_err(|error| Failure::new(crate::project_start::FAILED, format!("Your templates could not be read: {error}")))
}

fn write_user(file: &Path, templates: Vec<UserTemplate>) -> Result<(), Failure> {
    crate::store::write_json(file, &UserTemplates { templates }).map_err(|error| Failure::new(crate::project_start::FAILED, format!("Your templates could not be saved: {error}")))
}

fn user_info(template: &UserTemplate) -> TemplateInfo {
    let problem = (!Path::new(&template.path).is_dir()).then(|| format!("{} is no longer there.", template.path));
    TemplateInfo { id: template.id.clone(), name: template.name.clone(), description: template.path.clone(), built_in: false, path: Some(template.path.clone()), problem }
}

fn built_in_info(template: &BuiltIn) -> TemplateInfo {
    TemplateInfo { id: template.id.into(), name: template.name.into(), description: template.description.into(), built_in: true, path: None, problem: None }
}

pub fn list_in(file: &Path) -> Result<Vec<TemplateInfo>, Failure> {
    let mut all: Vec<TemplateInfo> = BUILT_INS.iter().map(built_in_info).collect();
    all.extend(read_user(file)?.iter().map(user_info));
    Ok(all)
}

/// The built-in templates, then the reader's own in the order they were added.
pub fn list() -> Result<Vec<TemplateInfo>, Failure> {
    list_in(&store_file()?)
}

/// Keep the folder at `path` as a template named after it. Adding the same
/// folder again returns the template already kept.
pub fn add_in(file: &Path, path: &str) -> Result<TemplateInfo, Failure> {
    let folder = PathBuf::from(path.trim());
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(Failure::new(INVALID_TEMPLATE, format!("{} is not a folder on this computer.", folder.display())));
    }
    let folder = folder.canonicalize().map_err(|error| Failure::io("Could not read the folder", error))?;
    if dirs::home_dir().is_some_and(|home| home == folder) || folder.parent().is_none() {
        return Err(Failure::new(INVALID_TEMPLATE, format!("{} holds too much to be a template. Choose the folder of one project.", folder.display())));
    }
    // Checked now, so the reader hears about a folder that is too big when adding it, not later.
    files_of(&folder)?;
    let shown = folder.to_string_lossy().into_owned();
    let mut templates = read_user(file)?;
    if let Some(existing) = templates.iter().find(|template| template.path == shown) {
        return Ok(user_info(existing));
    }
    let base = folder.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| shown.clone());
    let name = (1..).map(|n| if n == 1 { base.clone() } else { format!("{base} {n}") }).find(|name| !templates.iter().any(|template| &template.name == name)).expect("an unbounded range");
    let template = UserTemplate { id: format!("{USER_PREFIX}{}", uuid::Uuid::new_v4()), name, path: shown };
    let info = user_info(&template);
    templates.push(template);
    write_user(file, templates)?;
    Ok(info)
}

pub fn add(path: &str) -> Result<TemplateInfo, Failure> {
    add_in(&store_file()?, path)
}

/// Forget a user template. Its folder is not touched.
pub fn remove_in(file: &Path, id: &str) -> Result<(), Failure> {
    let mut templates = read_user(file)?;
    let before = templates.len();
    templates.retain(|template| template.id != id);
    if templates.len() != before {
        write_user(file, templates)?;
    }
    Ok(())
}

pub fn remove(id: &str) -> Result<(), Failure> {
    remove_in(&store_file()?, id)
}

pub const INVALID_TEMPLATE: &str = "invalid-template";

/// A template ready to write: every file it will make, read before anything
/// is made, so a template that cannot be read fails with nothing to clean up.
pub struct Prepared {
    pub name: String,
    files: Vec<PreparedFile>,
}

enum PreparedFile {
    Embedded(&'static BuiltInFile),
    Copied { relative: PathBuf, source: PathBuf },
}

pub fn prepare_in(file: &Path, id: &str) -> Result<Prepared, Failure> {
    if let Some(built_in) = BUILT_INS.iter().find(|template| template.id == id) {
        return Ok(Prepared { name: built_in.name.into(), files: built_in.files.iter().map(PreparedFile::Embedded).collect() });
    }
    if !id.starts_with(USER_PREFIX) {
        return Err(Failure::new(INVALID_TEMPLATE, "Choose a template for the project."));
    }
    let templates = read_user(file)?;
    let Some(template) = templates.iter().find(|template| template.id == id) else {
        return Err(Failure::new(INVALID_TEMPLATE, "That template was removed. Choose another one."));
    };
    let folder = Path::new(&template.path);
    if !folder.is_dir() {
        return Err(Failure::new(INVALID_TEMPLATE, format!("The {} template's folder, {}, is no longer there.", template.name, template.path)));
    }
    let files = files_of(folder)?.into_iter().map(|relative| PreparedFile::Copied { source: folder.join(&relative), relative }).collect();
    Ok(Prepared { name: template.name.clone(), files })
}

pub fn prepare(id: &str) -> Result<Prepared, Failure> {
    // A built-in template never needs the store, so a broken one cannot stop it.
    if BUILT_INS.iter().any(|template| template.id == id) {
        return prepare_in(Path::new(""), id);
    }
    prepare_in(&store_file()?, id)
}

/// The files a folder template makes, relative to it. A Git repository gives
/// what Git would commit there (tracked files and new ones it does not
/// ignore); any other folder gives everything except `SKIPPED_DIRS`.
fn files_of(folder: &Path) -> Result<Vec<PathBuf>, Failure> {
    let listed = if crate::git::is_repo(folder) { git_files(folder) } else { None };
    let files = match listed {
        Some(files) => files,
        None => {
            let mut files = Vec::new();
            walk(folder, Path::new(""), &mut files)?;
            files
        }
    };
    if files.len() > USER_TEMPLATE_FILE_LIMIT {
        return Err(Failure::new(INVALID_TEMPLATE, format!("{} has more than {USER_TEMPLATE_FILE_LIMIT} files, too many for a template.", folder.display())));
    }
    let bytes: u64 = files.iter().filter_map(|relative| std::fs::symlink_metadata(folder.join(relative)).ok()).map(|meta| meta.len()).sum();
    if bytes > USER_TEMPLATE_BYTE_LIMIT {
        return Err(Failure::new(INVALID_TEMPLATE, format!("{} holds more than {} MB, too much for a template.", folder.display(), USER_TEMPLATE_BYTE_LIMIT / 1024 / 1024)));
    }
    Ok(files)
}

/// `None` when the folder is inside a repository but is not its top, or Git
/// cannot list it: the folder is then read like any other.
fn git_files(folder: &Path) -> Option<Vec<PathBuf>> {
    let top = crate::git::run(folder, &["rev-parse", "--show-toplevel"]).ok()?;
    if Path::new(top.trim()).canonicalize().ok()? != folder.canonicalize().ok()? {
        return None;
    }
    let out = crate::git::run(folder, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).ok()?;
    let unique: BTreeSet<&str> = out.split('\0').filter(|entry| !entry.is_empty()).collect();
    // A tracked file deleted from the working tree is not part of the template.
    Some(unique.into_iter().map(PathBuf::from).filter(|relative| std::fs::symlink_metadata(folder.join(relative)).is_ok()).collect())
}

fn walk(root: &Path, relative: &Path, files: &mut Vec<PathBuf>) -> Result<(), Failure> {
    let entries = std::fs::read_dir(root.join(relative)).map_err(|error| Failure::io(&format!("Could not read {}", root.join(relative).display()), error))?;
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let path = relative.join(&name);
        let kind = entry.file_type().map_err(|error| Failure::io("Could not read the template", error))?;
        if kind.is_dir() {
            if !SKIPPED_DIRS.iter().any(|skipped| name == *skipped) {
                walk(root, &path, files)?;
            }
        } else {
            files.push(path);
        }
        if files.len() > USER_TEMPLATE_FILE_LIMIT {
            return Ok(());
        }
    }
    Ok(())
}

/// `{{package_name}}`'s value: a name npm accepts, made from the project's.
fn package_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        let keep = c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_');
        if keep {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_start_matches(['.', '_', '-']).trim_end_matches('-');
    if trimmed.is_empty() {
        "app".into()
    } else {
        trimmed.chars().take(214).collect()
    }
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn escape_js(text: &str) -> String {
    let quoted = serde_json::to_string(text).expect("a string serializes");
    // Also safe inside JSX text and `</script>`.
    quoted[1..quoted.len() - 1].replace('<', "\\u003c").replace('>', "\\u003e")
}

fn fill(contents: &str, fill: Fill, name: &str) -> String {
    let shown = match fill {
        Fill::None => return contents.to_string(),
        Fill::Text => name.to_string(),
        Fill::Html => escape_html(name),
        Fill::Js => escape_js(name),
    };
    contents.replace("{{package_name}}", &package_name(name)).replace("{{name}}", &shown)
}

/// Write the template's files into `dest`, an empty folder, for a project called `name`.
pub fn write(prepared: &Prepared, dest: &Path, name: &str) -> Result<(), Failure> {
    for file in &prepared.files {
        match file {
            PreparedFile::Embedded(file) => {
                let target = dest.join(file.path);
                make_parent(&target)?;
                std::fs::write(&target, fill(file.contents, file.fill, name)).map_err(|error| Failure::io(&format!("Could not write {}", file.path), error))?;
                if file.executable {
                    set_executable(&target)?;
                }
            }
            PreparedFile::Copied { relative, source } => {
                let target = dest.join(relative);
                make_parent(&target)?;
                copy_entry(source, &target).map_err(|error| Failure::io(&format!("Could not copy {}", relative.display()), error))?;
            }
        }
    }
    Ok(())
}

fn make_parent(target: &Path) -> Result<(), Failure> {
    match target.parent() {
        Some(parent) => std::fs::create_dir_all(parent).map_err(|error| Failure::io(&format!("Could not create {}", parent.display()), error)),
        None => Ok(()),
    }
}

/// A symlink is copied as a link, never followed: a template cannot pull in
/// files from outside its folder.
fn copy_entry(source: &Path, target: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(std::fs::read_link(source)?, target);
        #[cfg(not(unix))]
        return Ok(());
    }
    // `copy` carries the permission bits over, so scripts stay executable.
    std::fs::copy(source, target).map(|_| ())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), Failure> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|error| Failure::io("Could not make a script executable", error))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), Failure> {
    Ok(())
}

#[cfg(test)]
pub(crate) fn built_in_paths(id: &str) -> Vec<&'static str> {
    BUILT_INS.iter().find(|template| template.id == id).map(|template| template.files.iter().map(|file| file.path).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on_disk(dir: &Path, relative: &Path, out: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir.join(relative)).unwrap().filter_map(Result::ok) {
            let path = relative.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                on_disk(dir, &path, out);
            } else if entry.file_name() == "gitignore" {
                out.insert(relative.join(".gitignore").to_string_lossy().into_owned());
            } else {
                out.insert(path.to_string_lossy().into_owned());
            }
        }
    }

    #[test]
    fn every_file_in_a_template_folder_ships_with_the_app() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("templates");
        for template in &BUILT_INS {
            let mut found = BTreeSet::new();
            on_disk(&root.join(template.id), Path::new(""), &mut found);
            let shipped: BTreeSet<String> = template.files.iter().map(|file| file.path.to_string()).collect();
            assert_eq!(found, shipped, "{}", template.id);
        }
    }

    #[test]
    fn a_name_is_written_safely_into_every_kind_of_file() {
        assert_eq!(package_name("My App"), "my-app");
        assert_eq!(package_name("..._Weird  Name!!"), "weird-name");
        assert_eq!(package_name("日本"), "app");
        assert_eq!(fill("<title>{{name}}</title>", Fill::Html, "a<b>\"c\""), "<title>a&lt;b&gt;&quot;c&quot;</title>");
        assert_eq!(fill("\"{{name}}\"", Fill::Js, "say \"hi\" </script>"), "\"say \\\"hi\\\" \\u003c/script\\u003e\"");
        assert_eq!(fill("{\"name\": \"{{package_name}}\"}", Fill::Js, "Hello World"), "{\"name\": \"hello-world\"}");
        assert_eq!(fill("# {{name}}", Fill::Text, "Notes & Ideas"), "# Notes & Ideas");
        assert_eq!(fill("{{name}}", Fill::None, "x"), "{{name}}");
    }

    #[test]
    fn user_templates_are_kept_by_folder_and_can_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("project-templates.json");
        let folder = dir.path().join("house-style");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("README.md"), "x").unwrap();

        assert_eq!(list_in(&file).unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), [EMPTY, VITE_REACT, AGENT_STARTER]);
        let added = add_in(&file, &folder.to_string_lossy()).unwrap();
        assert_eq!(added.name, "house-style");
        assert!(!added.built_in && added.problem.is_none());
        assert_eq!(add_in(&file, &folder.to_string_lossy()).unwrap().id, added.id, "the same folder twice is one template");
        assert_eq!(list_in(&file).unwrap().len(), 4);

        std::fs::remove_dir_all(&folder).unwrap();
        assert!(list_in(&file).unwrap()[3].problem.is_some());
        assert_eq!(prepare_in(&file, &added.id).err().unwrap().code, INVALID_TEMPLATE);

        remove_in(&file, &added.id).unwrap();
        assert_eq!(list_in(&file).unwrap().len(), 3);
        assert_eq!(prepare_in(&file, &added.id).err().unwrap().code, INVALID_TEMPLATE);
        assert_eq!(prepare_in(&file, "nonsense").err().unwrap().code, INVALID_TEMPLATE);
    }

    #[test]
    fn a_folder_that_is_not_a_template_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("project-templates.json");
        assert_eq!(add_in(&file, "relative/folder").unwrap_err().code, INVALID_TEMPLATE);
        assert_eq!(add_in(&file, &dir.path().join("missing").to_string_lossy()).unwrap_err().code, INVALID_TEMPLATE);
        assert_eq!(add_in(&file, "/").unwrap_err().code, INVALID_TEMPLATE);
        let big = dir.path().join("big");
        std::fs::create_dir_all(&big).unwrap();
        for n in 0..=USER_TEMPLATE_FILE_LIMIT {
            std::fs::write(big.join(format!("{n}.txt")), "").unwrap();
        }
        assert_eq!(add_in(&file, &big.to_string_lossy()).unwrap_err().code, INVALID_TEMPLATE);
        assert!(!file.exists(), "nothing is saved for a refused folder");
    }

    #[test]
    fn a_git_folder_gives_what_git_would_commit_and_any_other_skips_dependencies() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        crate::git::run(&repo, &["init", "-q"]).unwrap();
        std::fs::write(repo.join(".gitignore"), "secret.env\n").unwrap();
        std::fs::write(repo.join("src/lib.rs"), "").unwrap();
        std::fs::write(repo.join("secret.env"), "TOKEN=1").unwrap();
        let files: BTreeSet<String> = files_of(&repo).unwrap().iter().map(|p| p.to_string_lossy().into_owned()).collect();
        assert_eq!(files, BTreeSet::from([".gitignore".to_string(), "src/lib.rs".to_string()]));

        let plain = dir.path().join("plain");
        std::fs::create_dir_all(plain.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(plain.join(".git")).unwrap();
        std::fs::write(plain.join("node_modules/x/index.js"), "").unwrap();
        std::fs::write(plain.join("a.txt"), "").unwrap();
        // A folder with a stray `.git` that is not a repository is read like any other.
        let files: Vec<PathBuf> = files_of(&plain).unwrap();
        assert_eq!(files, [PathBuf::from("a.txt")]);
    }
}
