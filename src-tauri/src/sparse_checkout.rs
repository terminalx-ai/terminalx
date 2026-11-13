//! Sparse workspaces (PRO-307). A repository's `sparseCheckout` setting names
//! the folders a new workspace checks out (git sparse-checkout, cone mode),
//! besides the files at its root. This module lists the folders there are to
//! choose from, read from the commit at the primary checkout's HEAD and never
//! its working tree; narrows a new worktree to the chosen folders; and writes
//! the note an agent launched in a sparse workspace is given.
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;

/// Most children listed under one top-level folder.
const MAX_CHILDREN: usize = 200;
/// Longest description, in characters.
const MAX_DESCRIPTION: usize = 80;
/// Largest manifest or README read for a description.
const MAX_DESCRIBED_FILE: u64 = 256 * 1024;
/// Paths per `git ls-tree` call when listing children, well under any argument limit.
const LS_TREE_CHUNK: usize = 256;
/// Most folders a note names before it points the agent at `git sparse-checkout list`.
const NOTE_FOLDERS: usize = 50;
/// How long reading a launch directory's sparse state may hold up an agent's start.
const NOTE_TIMEOUT: Duration = Duration::from_secs(5);

/// The shape of `RepositoryFolders` in `src/types/repositoryFolders.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFolder {
    pub path: String,
    pub description: Option<String>,
    pub size: Option<u64>,
    pub children: Vec<RepositoryFolder>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootFiles {
    pub count: u64,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFolders {
    pub folders: Vec<RepositoryFolder>,
    pub root_files: RootFiles,
    pub total_size: Option<u64>,
    pub sizes_error: Option<String>,
}

/// A git child for reading objects: no lazy fetch of a partial clone's
/// missing objects (`crate::git::git` sets it), literal paths, unquoted names.
fn git(cwd: &Path) -> std::process::Command {
    let mut command = crate::git::git();
    command.current_dir(cwd).env("GIT_NO_LAZY_FETCH", "1")
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .args(["--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false"]);
    command
}

fn output(cwd: &Path, args: &[&str], input: Option<Vec<u8>>) -> Result<Vec<u8>> {
    let mut command = git(cwd);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = command.spawn().with_context(|| format!("git {}", args.join(" ")))?;
    // Written from its own thread: a batch answer larger than the pipe
    // buffer would otherwise block git while it waits for us to read.
    let writer = input.map(|input| {
        let mut stdin = child.stdin.take().expect("piped stdin");
        std::thread::spawn(move || { let _ = stdin.write_all(&input); })
    });
    let out = child.wait_with_output()?;
    if let Some(writer) = writer { let _ = writer.join(); }
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
        bail!("git {}: {}", args.join(" "), if err.is_empty() { format!("exit {}", out.status) } else { err.to_string() });
    }
    Ok(out.stdout)
}

/// One `git ls-tree -z` record: type, object, size (with `-l`, `None` for a
/// gitlink's `-`) and path; `utf8` false for a name the setting, a JSON
/// string, could not name, which is read lossily for measuring only.
struct Entry { kind: String, size: Option<u64>, path: String, utf8: bool }

fn entries(bytes: &[u8], long: bool) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    for record in bytes.split(|b| *b == 0).filter(|record| !record.is_empty()) {
        let utf8 = std::str::from_utf8(record).is_ok();
        let record = String::from_utf8_lossy(record);
        let (meta, path) = record.split_once('\t').context("Unexpected git ls-tree output.")?;
        let mut fields = meta.split_whitespace();
        let (_mode, kind, _oid) = (fields.next(), fields.next().context("Unexpected git ls-tree output.")?, fields.next().context("Unexpected git ls-tree output.")?);
        let size = if long { fields.next().and_then(|size| size.parse().ok()) } else { None };
        out.push(Entry { kind: kind.into(), size, path: path.into(), utf8 });
    }
    Ok(out)
}

/// A folder of the listing: a tree, or a submodule's gitlink.
fn is_folder(entry: &Entry) -> bool { entry.utf8 && (entry.kind == "tree" || entry.kind == "commit") }

/// The folders a new workspace of `project` could check out, read from the
/// commit at its primary checkout's HEAD. With `measure`, each folder's size
/// is the sum of the blobs under it (a submodule counts as 0); when the sizes
/// cannot be read, as in a partial clone missing blobs, the listing is still
/// returned, every size `None` and `sizes_error` saying why.
pub fn folders(project: &Path, measure: bool) -> Result<RepositoryFolders> {
    let root = crate::store::configuration::repository(project)?.root;
    // One tree for every read below, so a HEAD that moves meanwhile cannot mix two commits.
    let Ok(tree) = output(&root, &["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], None) else {
        // An unborn branch has nothing to choose from yet.
        return Ok(RepositoryFolders { folders: Vec::new(), root_files: RootFiles { count: 0, size: measure.then_some(0) }, total_size: measure.then_some(0), sizes_error: None });
    };
    let tree = String::from_utf8(tree)?.trim().to_string();
    let top = entries(&output(&root, &["ls-tree", "-z", &tree], None)?, false)?;
    let root_count = top.iter().filter(|entry| entry.kind == "blob").count() as u64;
    let top_folders: Vec<&Entry> = top.iter().filter(|entry| is_folder(entry)).collect();

    // One level down, from one ls-tree per chunk of top-level trees.
    let mut below: HashMap<String, Vec<String>> = HashMap::new();
    let trees: Vec<&str> = top_folders.iter().filter(|entry| entry.kind == "tree").map(|entry| entry.path.as_str()).collect();
    for chunk in trees.chunks(LS_TREE_CHUNK) {
        let mut args = vec!["ls-tree".to_string(), "-z".into(), tree.clone(), "--".into()];
        args.extend(chunk.iter().map(|path| format!("{path}/")));
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        for entry in entries(&output(&root, &args, None)?, false)? {
            if !is_folder(&entry) { continue; }
            if let Some((parent, _)) = entry.path.split_once('/') {
                below.entry(parent.to_string()).or_default().push(entry.path);
            }
        }
    }
    let mut listing: Vec<RepositoryFolder> = top_folders.iter().map(|entry| {
        let children = below.remove(&entry.path).filter(|children| children.len() >= 2).unwrap_or_default();
        RepositoryFolder {
            path: entry.path.clone(), description: None, size: None,
            children: children.into_iter().take(MAX_CHILDREN).map(|path| RepositoryFolder { path, description: None, size: None, children: Vec::new() }).collect(),
        }
    }).collect();

    let paths: Vec<String> = listing.iter().flat_map(|folder| std::iter::once(folder.path.clone()).chain(folder.children.iter().map(|child| child.path.clone()))).collect();
    // A description is a nicety: one that cannot be read is no description.
    let descriptions = describe(&root, &tree, &paths).unwrap_or_else(|error| {
        log::warn!("read folder descriptions: {error:#}");
        HashMap::new()
    });
    for folder in &mut listing {
        folder.description = descriptions.get(&folder.path).cloned();
        for child in &mut folder.children { child.description = descriptions.get(&child.path).cloned(); }
    }

    let mut result = RepositoryFolders { folders: listing, root_files: RootFiles { count: root_count, size: None }, total_size: None, sizes_error: None };
    if measure {
        match sizes(&root, &tree) {
            Ok(sizes) => {
                for folder in &mut result.folders {
                    folder.size = Some(sizes.under.get(&folder.path).copied().unwrap_or(0));
                    for child in &mut folder.children { child.size = Some(sizes.under.get(&child.path).copied().unwrap_or(0)); }
                }
                result.root_files.size = Some(sizes.root);
                result.total_size = Some(sizes.total);
            }
            Err(error) => result.sizes_error = Some(format!("Folder sizes could not be read: {error:#}")),
        }
    }
    Ok(result)
}

struct Sizes { root: u64, total: u64, under: HashMap<String, u64> }

/// Blob sizes summed per top-level folder and per folder one level below,
/// from `git ls-tree -r -l`, which reads each blob's size from the object
/// store: a blob that is not there fails the whole measurement.
fn sizes(root: &Path, tree: &str) -> Result<Sizes> {
    let mut sizes = Sizes { root: 0, total: 0, under: HashMap::new() };
    for entry in entries(&output(root, &["ls-tree", "-r", "-l", "-z", tree], None)?, true)? {
        if entry.kind != "blob" { continue; }
        // A blob missing from a partial clone is listed with the size `BAD`, exit 0.
        let size = entry.size.with_context(|| format!("{} is not in this repository's local objects (a partial clone?)", entry.path))?;
        sizes.total += size;
        let mut segments = entry.path.splitn(3, '/');
        let first = segments.next().unwrap_or_default();
        match (segments.next(), segments.next()) {
            (None, _) => sizes.root += size,
            (Some(second), rest) => {
                *sizes.under.entry(first.to_string()).or_default() += size;
                // Only a file inside the second-level folder counts toward it.
                if rest.is_some() { *sizes.under.entry(format!("{first}/{second}")).or_default() += size; }
            }
        }
    }
    Ok(sizes)
}

/// Where a folder's description is looked for, in order.
const DESCRIBED_BY: [&str; 3] = ["package.json", "Cargo.toml", "README.md"];

/// Each folder's description, from `git cat-file`: sizes first, then the
/// contents of the files small enough to read.
fn describe(root: &Path, tree: &str, folders: &[String]) -> Result<HashMap<String, String>> {
    // A name with a line break cannot be one line of a batch request.
    let folders: Vec<&String> = folders.iter().filter(|folder| !folder.contains('\n')).collect();
    let mut request = String::new();
    for folder in &folders {
        for file in DESCRIBED_BY { request.push_str(&format!("{tree}:{folder}/{file}\n")); }
    }
    let answer = output(root, &["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], Some(request.into_bytes()))?;
    let answer = String::from_utf8_lossy(&answer);
    let mut lines = answer.lines();
    let mut wanted: Vec<(usize, usize, String)> = Vec::new();
    for (folder, _) in folders.iter().enumerate() {
        for file in 0..DESCRIBED_BY.len() {
            let line = lines.next().context("git cat-file answered fewer lines than asked")?;
            if line.ends_with(" missing") || line.ends_with(" ambiguous") { continue; }
            let mut fields = line.split(' ');
            if let (Some(oid), Some("blob"), Some(size)) = (fields.next(), fields.next(), fields.next().and_then(|size| size.parse::<u64>().ok())) {
                if size <= MAX_DESCRIBED_FILE { wanted.push((folder, file, oid.to_string())); }
            }
        }
    }
    if wanted.is_empty() { return Ok(HashMap::new()); }
    let request: String = wanted.iter().map(|(_, _, oid)| format!("{oid}\n")).collect();
    let contents = output(root, &["cat-file", "--batch"], Some(request.into_bytes()))?;
    let mut found: HashMap<(usize, usize), String> = HashMap::new();
    let mut rest = contents.as_slice();
    for (folder, file, _) in &wanted {
        let end = rest.iter().position(|b| *b == b'\n').context("Unexpected git cat-file output.")?;
        let header = String::from_utf8_lossy(&rest[..end]).into_owned();
        rest = &rest[end + 1..];
        let mut fields = header.split(' ');
        let (Some(_), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let size: usize = size.parse().context("Unexpected git cat-file output.")?;
        let text = String::from_utf8_lossy(rest.get(..size).context("Short git cat-file output.")?).into_owned();
        rest = rest.get(size + 1..).unwrap_or_default();
        if kind == "blob" { found.insert((*folder, *file), text); }
    }
    let mut out = HashMap::new();
    for (index, folder) in folders.iter().enumerate() {
        let description = (0..DESCRIBED_BY.len()).find_map(|file| {
            let text = found.get(&(index, file))?;
            match file { 0 => package_description(text), 1 => cargo_description(text), _ => readme_description(text) }
        });
        if let Some(description) = description { out.insert((*folder).clone(), description); }
    }
    Ok(out)
}

/// One line of at most `MAX_DESCRIPTION` characters, or none when blank.
fn one_line(text: &str) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() { return None; }
    if text.chars().count() <= MAX_DESCRIPTION { return Some(text); }
    let cut: String = text.chars().take(MAX_DESCRIPTION - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

pub(crate) fn package_description(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    one_line(value.get("description")?.as_str()?)
}

pub(crate) fn cargo_description(text: &str) -> Option<String> {
    let value: toml::Table = toml::from_str(text).ok()?;
    one_line(value.get("package")?.get("description")?.as_str()?)
}

/// The README's first line of prose: past front matter, headings (ATX and
/// setext), badges, images, HTML, code blocks and horizontal rules.
pub(crate) fn readme_description(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut index = 0;
    if lines.first() == Some(&"---") {
        index = lines.iter().skip(1).position(|line| *line == "---").map(|end| end + 2).unwrap_or(0);
    }
    let rule = |line: &str| line.len() >= 2 && (line.chars().all(|c| c == '=') || line.chars().all(|c| c == '-') || line.chars().all(|c| c == '*'));
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if let Some(fence) = ["```", "~~~"].into_iter().find(|fence| line.starts_with(fence)) {
            index += lines[index..].iter().position(|line| line.starts_with(fence)).map_or(lines.len() - index, |end| end + 1);
            continue;
        }
        if line.is_empty() || line.starts_with('#') || line.starts_with("[![") || line.starts_with("![") || line.starts_with('<') || rule(line) { continue; }
        // A setext heading is underlined on the next line.
        if lines.get(index).is_some_and(|next| rule(next) && !next.starts_with('*')) { index += 1; continue; }
        return one_line(line);
    }
    None
}

/// Narrow a worktree made with `git worktree add --no-checkout` to `folders`
/// and the root files, then check it out. The sparse configuration is the
/// worktree's own (`git config --worktree`): the primary checkout and the
/// repository's other worktrees keep everything they have.
pub(crate) fn populate(worktree: &Path, folders: &[String]) -> Result<()> {
    // `--stdin` C-unquotes a line that starts with a quote; quoting every
    // folder keeps any name (no backslash or control character: `valid()`) as it is.
    let input: String = folders.iter().map(|folder| format!("\"{}\"\n", folder.replace('"', "\\\""))).collect();
    output(worktree, &["sparse-checkout", "set", "--cone", "--stdin"], Some(input.into_bytes()))?;
    output(worktree, &["checkout", "-q"], None)?;
    Ok(())
}

/// The note an agent launched in `cwd` is given when that checkout is sparse,
/// read from the checkout itself, so a workspace made outside TerminalX is
/// covered too. `None` for a full checkout or outside a repository.
pub fn agent_note(cwd: &Path) -> Option<String> {
    let read = |args: &[&str]| {
        let mut command = git(cwd);
        command.args(args);
        crate::git::output_within(command, NOTE_TIMEOUT).ok()
    };
    if read(&["config", "--get", "--bool", "core.sparseCheckout"])?.trim() != "true" { return None; }
    let cone = read(&["config", "--get", "--bool", "core.sparseCheckoutCone"]).is_some_and(|value| value.trim() == "true");
    let list = read(&["sparse-checkout", "list"])?;
    let entries: Vec<String> = list.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect();
    Some(note_text(cone, &entries))
}

/// The note for a sparse checkout of `entries`: folders in cone mode, the
/// sparse-checkout patterns otherwise.
pub(crate) fn note_text(cone: bool, entries: &[String]) -> String {
    let mut named = entries.iter().take(NOTE_FOLDERS).map(|entry| format!("`{entry}`")).collect::<Vec<_>>().join(", ");
    if entries.len() > NOTE_FOLDERS {
        named.push_str(&format!(" and {} more (`git sparse-checkout list` names them all)", entries.len() - NOTE_FOLDERS));
    }
    let here = match (cone, entries.is_empty()) {
        (true, true) => "only the files at the repository's root are on disk here, no folder".to_string(),
        (true, false) => format!("only the files at the repository's root and these folders are on disk here (with the files directly inside each of their parent folders): {named}"),
        (false, true) => "no sparse-checkout pattern is set, so almost nothing is on disk here".to_string(),
        (false, false) => format!("only the paths these sparse-checkout patterns match are on disk here: {named}"),
    };
    format!(
        "This workspace is a sparse checkout of its repository: {here}. The repository has other folders that exist in it but are not checked out in this workspace. \
Do not try to recreate them, copy them in from elsewhere or change the sparse checkout yourself. \
If the task needs a folder that is not here, tell the user which folder you need and why; they can add it with `git sparse-checkout add <folder>` in this workspace."
    )
}

#[cfg(test)]
#[path = "sparse_checkout_tests.rs"]
mod tests;
