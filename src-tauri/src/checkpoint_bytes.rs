//! The exact bytes of files a checkpoint's tree cannot give back.
//!
//! A tree holds line endings as git normalized them, and a restore applies the
//! checkout's settings again. A file whose ending differs from what those
//! settings produce (LF under `core.autocrlf=true`, CRLF under `input`) would
//! come back changed, and an edit of its endings alone would leave the tree
//! the same. So a checkpoint is a [`Snapshot`]: the tree, and a second tree of
//! those files' raw bytes, pinned beside it as `<edge>-bytes`. Files with a
//! clean/smudge filter, such as LFS, are left to git.
use super::*;
use std::io::Write;
use std::process::Stdio;

/// Larger files are restored as git writes them.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// A checkout's files at one moment.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Snapshot {
    pub tree: String,
    /// The tree of kept bytes. `None`: not known (an older checkpoint, or no
    /// line-ending conversion applies), so nothing is compared or restored
    /// beyond the tree. The empty tree: known, and nothing needed keeping.
    pub kept: Option<String>,
}

impl Snapshot {
    pub fn new(tree: impl Into<String>, kept: Option<String>) -> Self {
        Self { tree: tree.into(), kept }
    }

    /// The tree's files exactly as a checkout of it writes them.
    pub fn as_git_writes(tree: impl Into<String>) -> Self {
        Self::new(tree, Some(EMPTY_TREE.to_string()))
    }

    /// The tree of kept bytes, when it holds any.
    pub fn kept_bytes(&self) -> Option<&str> {
        self.kept.as_deref().filter(|kept| *kept != EMPTY_TREE)
    }

    /// Names these exact files: the tree alone unless bytes were kept.
    pub fn identity(&self) -> String {
        match self.kept_bytes() {
            Some(kept) => format!("{}+{kept}", self.tree),
            None => self.tree.clone(),
        }
    }
}

fn piped(cwd: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>> {
    let mut child = git().current_dir(cwd).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    // Written beside the read: git may fill its output before it has read all of this.
    let output = std::thread::scope(|scope| {
        let writer = scope.spawn(move || stdin.write_all(input));
        let output = child.wait_with_output();
        let _ = writer.join();
        output
    })?;
    if !output.status.success() {
        bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr));
    }
    Ok(output.stdout)
}

fn setting(cwd: &Path, key: &str) -> String {
    run(cwd, &["config", "--get", key]).map(|value| value.trim().to_ascii_lowercase()).unwrap_or_default()
}

fn autocrlf(cwd: &Path) -> &'static str {
    match setting(cwd, "core.autocrlf").as_str() {
        "true" | "yes" | "on" | "1" => "true",
        "input" => "input",
        _ => "",
    }
}

/// The ending a checkout writes for a file, or `None` when it writes the
/// blob's bytes unchanged. `native_crlf`: this platform's own ending is CRLF.
fn checkout_ending(index: &str, attributes: &str, autocrlf: &str, core_eol: &str, native_crlf: bool) -> Option<&'static str> {
    let has = |wanted: &str| attributes.split_whitespace().any(|attribute| attribute == wanted);
    if has("-text") {
        return None;
    }
    let eol = if has("eol=crlf") { Some("crlf") } else if has("eol=lf") { Some("lf") } else { None };
    let automatic = has("text=auto");
    let always = has("text") || (eol.is_some() && !automatic);
    if !always && !automatic && autocrlf.is_empty() {
        return None;
    }
    // Automatic conversion leaves a blob that already holds a CR alone.
    if !always && index != "lf" {
        return None;
    }
    Some(eol.unwrap_or(match (autocrlf, core_eol) {
        ("true", _) => "crlf",
        ("input", _) => "lf",
        (_, "crlf") => "crlf",
        (_, "lf") => "lf",
        _ if native_crlf => "crlf",
        _ => "lf",
    }))
}

/// Paths in `listing` (`ls-files --eol -z`) a restore would not reproduce.
fn differing(listing: &str, autocrlf: &str, core_eol: &str, native_crlf: bool) -> Vec<String> {
    listing
        .split('\0')
        .filter_map(|entry| {
            let (info, path) = entry.split_once('\t')?;
            let mut fields = info.split_whitespace();
            let index = fields.next()?.strip_prefix("i/")?;
            let worktree = fields.next()?.strip_prefix("w/")?;
            let attributes = info.split_once("attr/")?.1;
            let readable = matches!(worktree, "lf" | "crlf" | "mixed") && index != "-text";
            let written = checkout_ending(index, attributes, autocrlf, core_eol, native_crlf).unwrap_or(index);
            (readable && worktree != written && !path.contains('\n')).then(|| path.to_string())
        })
        .collect()
}

fn name_of(path: &str) -> String {
    path.bytes().map(|byte| format!("{byte:02x}")).collect()
}

fn path_of(name: &str) -> Option<String> {
    if !name.len().is_multiple_of(2) {
        return None;
    }
    let bytes = (0..name.len()).step_by(2).map(|at| u8::from_str_radix(name.get(at..at + 2)?, 16).ok()).collect::<Option<Vec<_>>>()?;
    String::from_utf8(bytes).ok()
}

fn filtered(cwd: &Path, paths: &[String]) -> Result<BTreeSet<String>> {
    if paths.is_empty() {
        return Ok(BTreeSet::new());
    }
    let input = paths.iter().flat_map(|path| path.bytes().chain([0])).collect::<Vec<_>>();
    let answer = piped(cwd, &["check-attr", "-z", "--stdin", "filter"], &input)?;
    let answer = String::from_utf8_lossy(&answer);
    let fields: Vec<&str> = answer.split('\0').collect();
    Ok(fields.as_chunks::<3>().0.iter().filter(|entry| entry[2] != "unspecified").map(|entry| entry[0].to_string()).collect())
}

/// Without a filter, and a regular file small enough to keep.
fn keepable(cwd: &Path, paths: Vec<String>) -> Result<Vec<String>> {
    let filtered = filtered(cwd, &paths)?;
    Ok(paths
        .into_iter()
        .filter(|path| !filtered.contains(path))
        .filter(|path| std::fs::symlink_metadata(cwd.join(path)).is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_FILE_BYTES))
        .collect())
}

/// Whether any setting or attribute file could convert line endings here.
fn conversion_possible(cwd: &Path, autocrlf: &str, core_eol: &str) -> bool {
    if !autocrlf.is_empty() || !core_eol.is_empty() || !setting(cwd, "core.attributesfile").is_empty() {
        return true;
    }
    let local = run(cwd, &["rev-parse", "--git-path", "info/attributes"]).is_ok_and(|path| {
        let path = Path::new(path.trim());
        let path = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
        std::fs::metadata(path).is_ok_and(|meta| meta.len() > 0)
    });
    local
        || cwd.join(".gitattributes").exists()
        || run(cwd, &["ls-files", "--", ":(glob)**/.gitattributes"]).map_or(true, |tracked| !tracked.trim().is_empty())
}

/// Keep the bytes of the files in `index` that a restore would change, and
/// say which tree holds them. Writes objects only: a snapshot is pinned, or
/// not, by whoever asked for it. `None` when no conversion applies, or from
/// anywhere but the checkout's root, whose paths are what a tree names.
pub(crate) fn record(cwd: &Path, index: &Path) -> Result<Option<String>> {
    if !run(cwd, &["rev-parse", "--show-prefix"])?.trim().is_empty() {
        return Ok(None);
    }
    let (autocrlf, core_eol) = (autocrlf(cwd), setting(cwd, "core.eol"));
    if !conversion_possible(cwd, autocrlf, &core_eol) {
        return Ok(None);
    }
    let output = git().current_dir(cwd).env("GIT_INDEX_FILE", index).args(["ls-files", "--eol", "-z"]).output()?;
    if !output.status.success() {
        bail!("ls-files: {}", String::from_utf8_lossy(&output.stderr));
    }
    let paths = keepable(cwd, differing(&String::from_utf8_lossy(&output.stdout), autocrlf, &core_eol, cfg!(windows)))?;
    if paths.is_empty() {
        return Ok(Some(EMPTY_TREE.to_string()));
    }
    let input = paths.iter().map(|path| format!("{path}\n")).collect::<String>();
    let ids = String::from_utf8(piped(cwd, &["hash-object", "-w", "--no-filters", "--stdin-paths"], input.as_bytes())?)?;
    let entries = ids.lines().zip(&paths).map(|(id, path)| format!("100644 blob {id}\t{}\0", name_of(path))).collect::<String>();
    let kept = String::from_utf8(piped(cwd, &["mktree", "-z"], entries.as_bytes())?)?;
    Ok(Some(kept.trim().to_string()))
}

/// The files whose kept bytes differ between two recorded snapshots.
pub(crate) fn changed_paths(cwd: &Path, a: &Snapshot, b: &Snapshot) -> Result<Vec<String>> {
    let (Some(first), Some(second)) = (a.kept.as_deref(), b.kept.as_deref()) else { return Ok(Vec::new()) };
    if first == second {
        return Ok(Vec::new());
    }
    let names = run(cwd, &["diff-tree", "-r", "--no-renames", "--name-only", "-z", first, second])?;
    Ok(names.split('\0').filter(|name| !name.is_empty()).filter_map(path_of).collect())
}

fn write_if_different(target: &Path, bytes: &[u8]) -> Result<()> {
    // Only over the regular file git left there; never through a link.
    if !std::fs::symlink_metadata(target)?.is_file() || std::fs::read(target).is_ok_and(|now| now == bytes) {
        return Ok(());
    }
    std::fs::write(target, bytes)?;
    Ok(())
}

fn write_blob(cwd: &Path, id: &str, path: &str) -> Result<()> {
    let output = git().current_dir(cwd).args(["cat-file", "blob", id]).output()?;
    if !output.status.success() {
        bail!("read kept bytes of {path}: {}", String::from_utf8_lossy(&output.stderr));
    }
    write_if_different(&cwd.join(path), &output.stdout)
}

/// What a checkout of `tree` writes for `path`. `git restore` may skip a file
/// whose cached stat calls it current though only its endings differ.
fn write_as_git_would(cwd: &Path, tree: &str, path: &str) -> Result<()> {
    if !filtered(cwd, &[path.to_string()])?.is_empty() {
        return Ok(());
    }
    let output = git().current_dir(cwd).args(["cat-file", "--filters", &format!("{tree}:{path}")]).output()?;
    if !output.status.success() {
        bail!("read {path} from a checkpoint: {}", String::from_utf8_lossy(&output.stderr));
    }
    write_if_different(&cwd.join(path), &output.stdout)
}

/// Give `path`, just restored from `snapshot`, its exact bytes.
pub(super) fn put_back(cwd: &Path, snapshot: &Snapshot, path: &str) -> Result<()> {
    let Some(kept) = snapshot.kept.as_deref() else { return Ok(()) };
    if kept != EMPTY_TREE {
        if let Ok(id) = run(cwd, &["rev-parse", "--verify", "--quiet", &format!("{kept}:{}", name_of(path))]) {
            return write_blob(cwd, id.trim(), path);
        }
    }
    write_as_git_would(cwd, &snapshot.tree, path)
}

/// The same for every file kept for a snapshot, after a whole checkout of it.
pub(crate) fn put_back_all(cwd: &Path, snapshot: &Snapshot) -> Result<()> {
    let Some(kept) = snapshot.kept_bytes() else { return Ok(()) };
    for entry in run(cwd, &["ls-tree", "-z", kept])?.split('\0') {
        let Some((info, name)) = entry.split_once('\t') else { continue };
        let (Some(id), Some(path)) = (info.split_whitespace().nth(2), path_of(name)) else { continue };
        safe_path(cwd, &path)?;
        if cwd.join(&path).exists() {
            write_blob(cwd, id, &path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact(p: &Path) -> Snapshot {
        crate::git::exact_snapshot(p).unwrap()
    }

    fn autocrlf_repo() -> tempfile::TempDir {
        let repo = super::super::super::tests::repo();
        run(repo.path(), &["config", "core.autocrlf", "true"]).unwrap();
        // The file the fixture committed, as this setting checks it out.
        std::fs::write(repo.path().join("a.txt"), "hello\r\n").unwrap();
        repo
    }

    #[test]
    fn the_ending_a_checkout_writes_follows_attributes_then_settings() {
        assert_eq!(checkout_ending("lf", "", "", "", false), None);
        assert_eq!(checkout_ending("lf", "", "true", "", false), Some("crlf"));
        assert_eq!(checkout_ending("lf", "", "input", "", true), Some("lf"));
        assert_eq!(checkout_ending("lf", "-text", "true", "", false), None);
        assert_eq!(checkout_ending("lf", "text=auto eol=lf", "true", "", false), Some("lf"));
        assert_eq!(checkout_ending("lf", "text", "", "crlf", false), Some("crlf"));
        assert_eq!(checkout_ending("lf", "text", "", "", true), Some("crlf"), "native on Windows");
        assert_eq!(checkout_ending("lf", "text", "", "native", true), Some("crlf"));
        assert_eq!(checkout_ending("lf", "text", "", "lf", true), Some("lf"));
        assert_eq!(checkout_ending("crlf", "", "true", "", false), None, "automatic conversion leaves a blob with a CR alone");
        assert_eq!(checkout_ending("crlf", "text eol=lf", "", "", false), Some("lf"));
    }

    #[test]
    fn only_files_a_restore_would_change_are_kept() {
        let listing = "i/lf    w/lf    attr/                 \tkept.txt\0i/lf    w/crlf  attr/                 \tusual.txt\0i/lf    w/mixed attr/                 \tmixed.txt\0i/-text w/-text attr/                 \tbinary.bin\0";
        assert_eq!(differing(listing, "true", "", false), ["kept.txt", "mixed.txt"]);
        assert_eq!(differing(listing, "input", "", false), ["usual.txt", "mixed.txt"]);
    }

    #[test]
    fn a_name_is_its_path_and_back() {
        for path in ["a.txt", "dir/é file.txt"] {
            assert_eq!(path_of(&name_of(path)).as_deref(), Some(path));
        }
        assert_eq!(path_of("abc"), None);
    }

    #[test]
    fn a_restore_gives_back_each_files_exact_line_endings() {
        let _home = crate::store::temp_home();
        let repo = autocrlf_repo();
        let p = repo.path();
        let files: [(&str, &[u8]); 3] = [("lf.txt", b"one\ntwo\n"), ("crlf.txt", b"one\r\ntwo\r\n"), ("mixed.txt", b"one\r\ntwo\n")];
        for (name, bytes) in files {
            std::fs::write(p.join(name), bytes).unwrap();
        }
        let before = exact(p);
        let index = run(p, &["write-tree"]).unwrap().trim().to_string();
        for (name, _) in files {
            std::fs::write(p.join(name), "edited\n").unwrap();
        }
        let after = exact(p);
        let changed: Vec<String> = files.iter().map(|(name, _)| name.to_string()).collect();
        restore_exact(p, &before, &index, &changed).unwrap();
        for (name, bytes) in files {
            assert_eq!(std::fs::read(p.join(name)).unwrap(), bytes, "{name}");
        }
        assert_ne!(before.identity(), after.identity());
    }

    #[test]
    fn two_snapshots_of_one_tree_each_keep_their_own_endings() {
        let _home = crate::store::temp_home();
        let repo = autocrlf_repo();
        let p = repo.path();
        std::fs::write(p.join("f.txt"), "one\ntwo\n").unwrap();
        let lf = exact(p);
        std::fs::write(p.join("f.txt"), "one\r\ntwo\n").unwrap();
        let mixed = exact(p);
        assert_eq!(lf.tree, mixed.tree, "git sees one tree");
        assert_ne!(lf.identity(), mixed.identity());
        assert_eq!(exact_paths(p, &lf, &mixed).unwrap(), ["f.txt"]);
        let index = run(p, &["write-tree"]).unwrap().trim().to_string();
        restore_exact(p, &lf, &index, &["f.txt".to_string()]).unwrap();
        assert_eq!(std::fs::read(p.join("f.txt")).unwrap(), b"one\ntwo\n");
        restore_exact(p, &mixed, &index, &["f.txt".to_string()]).unwrap();
        assert_eq!(std::fs::read(p.join("f.txt")).unwrap(), b"one\r\ntwo\n");
    }

    #[test]
    fn restoring_the_usual_ending_works_after_git_refreshed_its_index() {
        let _home = crate::store::temp_home();
        let repo = autocrlf_repo();
        let p = repo.path();
        std::fs::write(p.join("f.txt"), "one\r\n").unwrap();
        run(p, &["add", "f.txt"]).unwrap();
        let usual = exact(p);
        assert_eq!(usual.kept_bytes(), None);
        std::fs::write(p.join("f.txt"), "one\n").unwrap();
        run(p, &["status", "--porcelain"]).unwrap();
        let index = run(p, &["write-tree"]).unwrap().trim().to_string();
        restore_exact(p, &usual, &index, &["f.txt".to_string()]).unwrap();
        assert_eq!(std::fs::read(p.join("f.txt")).unwrap(), b"one\r\n");
    }

    #[test]
    fn a_plain_snapshot_records_nothing_and_a_subfolder_is_not_kept_under_the_wrong_name() {
        let _home = crate::store::temp_home();
        let repo = autocrlf_repo();
        let p = repo.path();
        std::fs::create_dir(p.join("sub")).unwrap();
        std::fs::write(p.join("sub/a.txt"), "sub\n").unwrap();
        let refs = || run(p, &["for-each-ref"]).unwrap();
        let before = refs();
        snapshot_tree(p).unwrap();
        assert_eq!(refs(), before, "a read-only snapshot leaves no ref");
        assert_eq!(exact(&p.join("sub")).kept, None, "only the root's paths name a tree's");
        let root = exact(p);
        let root_index = run(p, &["write-tree"]).unwrap().trim().to_string();
        std::fs::write(p.join("a.txt"), "root edit\r\n").unwrap();
        restore_exact(p, &root, &root_index, &["a.txt".to_string()]).unwrap();
        assert_eq!(std::fs::read(p.join("a.txt")).unwrap(), b"hello\r\n", "the root file, not the subfolder's");
    }

    #[test]
    fn without_any_conversion_a_snapshot_is_just_its_tree() {
        let _home = crate::store::temp_home();
        let repo = super::super::super::tests::repo();
        let p = repo.path();
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        // With a system config that converts, this repository's own setting is what is asked.
        if autocrlf(p).is_empty() && setting(p, "core.eol").is_empty() {
            let snapshot = exact(p);
            assert_eq!(snapshot.kept, None);
            assert_eq!(snapshot.identity(), snapshot.tree);
        }
    }

    #[test]
    fn kept_bytes_are_pinned_with_their_checkpoint_and_go_with_it() {
        let _home = crate::store::temp_home();
        let repo = autocrlf_repo();
        let p = repo.path();
        std::fs::write(p.join("lf.txt"), "one\n").unwrap();
        let kept = exact(p);
        assert!(kept.kept_bytes().is_some());
        pin_exact(p, "session", "tab-1", &[("start", &kept)], &[]).unwrap();
        let bytes = reference("session", "tab-1", "start-bytes").unwrap();
        assert!(run_ok(p, &["show-ref", "--verify", "--quiet", &bytes]));
        std::fs::write(p.join("lf.txt"), "one\r\n").unwrap();
        let usual = exact(p);
        pin_exact(p, "session", "tab-1", &[("start", &usual)], &[]).unwrap();
        assert!(!run_ok(p, &["show-ref", "--verify", "--quiet", &bytes]), "pinning an edge again clears what it no longer holds");
        pin_exact(p, "session", "tab-1", &[("start", &kept)], &[]).unwrap();
        prune_turn(p, "session", "tab-1").unwrap();
        assert!(!run_ok(p, &["show-ref", "--verify", "--quiet", &bytes]));
    }
}
