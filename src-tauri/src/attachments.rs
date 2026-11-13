//! Files attached to a message (PRO-290), besides its images.
//!
//! Each `store` call copies the files it is given into one new folder of the
//! session's attachments folder, `$TERMINALX_HOME/attachments/<session>/<six
//! base36 characters>/<name>`, which goes with the session
//! (`session_ops::remove_session_entries`). A message then carries the stored
//! [`FileRef`]s: the chat shows them as chips, and the agent is handed their
//! absolute paths in a block after the text the person typed
//! ([`with_block`]). A CLI's own record of the prompt holds that block, which
//! its decoder takes off again ([`split_block`]) so the chat shows the text as
//! it was typed and the files as files.
//!
//! The rules are those of `src/lib/attachmentRules.ts`, enforced again here
//! so a client that skips them is still refused: at most
//! [`MAX_FILES_PER_MESSAGE`] files, none over [`MAX_ATTACHMENT_BYTES`], and
//! none with a name TerminalX uses for its own files
//! (`src/lib/reservedAttachmentNames.json`, the one list both sides read).

use std::{
    collections::HashSet,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::LazyLock,
};

use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};

use crate::{events::FileRef, store};

/// At most this many files (images included) go with one message.
pub const MAX_FILES_PER_MESSAGE: usize = 10;
/// A file larger than this is refused.
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
/// The line that opens the list of attached paths in the agent's prompt.
pub const BLOCK_HEADER: &str = "Attached files:";

static RESERVED: LazyLock<HashSet<String>> = LazyLock::new(|| {
    let names: Vec<String> = serde_json::from_str(include_str!("../../src/lib/reservedAttachmentNames.json"))
        .expect("valid reserved attachment names");
    names.into_iter().map(|name| name.to_lowercase()).collect()
});

/// A file for a message before it is stored: a path on this computer, or the
/// base64 bytes of a browser `File`. Exactly one of `path` and `data`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInput {
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub media_type: Option<String>,
}

/// What `inspect` learns about a path before it is attached.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    pub path: String,
    pub name: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// Not a regular file (a folder, a socket) or unreadable: never attached.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
}

/// The last segment of a name or path, by either separator.
fn base_name(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

/// A name TerminalX uses for its own session and project files, in any letter case.
pub fn is_reserved(name: &str) -> bool {
    RESERVED.contains(&base_name(name).to_lowercase())
}

/// The name a file is stored under: its last path segment, never empty,
/// `.` or `..`, and with no control characters.
fn sanitized(name: &str) -> Result<String> {
    let base: String = base_name(name).chars().filter(|c| !c.is_control()).collect();
    let base = base.trim().to_string();
    ensure!(!base.is_empty() && base != "." && base != "..", "“{name}” is not a file name that can be attached.");
    Ok(base)
}

/// `name`, or `name (2).ext`, `name (3).ext`… when one call already used it.
/// Compared without case, as the Mac's file system does.
fn unique(name: &str, used: &mut HashSet<String>) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    let mut candidate = name.to_string();
    let mut n = 2;
    while !used.insert(candidate.to_lowercase()) {
        candidate = format!("{stem} ({n}){ext}");
        n += 1;
    }
    candidate
}

fn media_type_of(path: &Path) -> Option<String> {
    crate::media_types::media_type(path).map(|m| m.mime.clone())
}

/// A session id names one folder under attachments/ and nothing else.
fn session_folder(session_id: &str) -> Result<PathBuf> {
    ensure!(
        !session_id.is_empty() && session_id != "." && session_id != ".." && !session_id.contains(['/', '\\', '\0']),
        "That is not a session."
    );
    let dir = store::attachments_dir(session_id)?;
    dir.canonicalize().with_context(|| format!("open the attachments folder {}", dir.display()))
}

/// Six lowercase base36 characters.
fn folder_name() -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut n = u128::from_le_bytes(*uuid::Uuid::new_v4().as_bytes());
    (0..6).map(|_| { let digit = DIGITS[(n % 36) as usize] as char; n /= 36; digit }).collect()
}

/// One new folder in `dir`, never one an earlier call made.
fn new_folder(dir: &Path) -> Result<PathBuf> {
    for _ in 0..64 {
        let folder = dir.join(folder_name());
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).with_context(|| format!("create {}", folder.display())),
        }
    }
    bail!("Could not make a new attachments folder in {}.", dir.display())
}

/// Where one file's bytes come from, once it has passed the rules.
enum Source {
    Path(PathBuf),
    Bytes(Vec<u8>),
}

fn too_large(name: &str) -> anyhow::Error {
    anyhow!("{name} is larger than {} MB. Files that large can’t be attached.", MAX_ATTACHMENT_BYTES / 1024 / 1024)
}

fn reserved(name: &str) -> anyhow::Error {
    anyhow!("{name} is a name TerminalX uses for session files. Rename it and attach it again.")
}

/// Check one file against the rules, and say where its bytes are.
fn admit_input(file: &FileInput) -> Result<(String, Source, u64)> {
    let name = sanitized(&file.name)?;
    if is_reserved(&name) { return Err(reserved(&name)); }
    match (&file.path, &file.data) {
        (Some(path), None) => {
            let path = PathBuf::from(path);
            let meta = std::fs::metadata(&path).with_context(|| format!("{name} can’t be read."))?;
            ensure!(meta.is_file(), "{name} is not a file that can be attached.");
            if meta.len() > MAX_ATTACHMENT_BYTES { return Err(too_large(&name)); }
            std::fs::File::open(&path).with_context(|| format!("{name} can’t be read."))?;
            Ok((name, Source::Path(path), meta.len()))
        }
        (None, Some(data)) => {
            // Base64 is a third larger than the bytes: refuse before decoding.
            if (data.len() as u64 / 4) * 3 > MAX_ATTACHMENT_BYTES + 3 { return Err(too_large(&name)); }
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).with_context(|| format!("{name} did not arrive whole."))?;
            if bytes.len() as u64 > MAX_ATTACHMENT_BYTES { return Err(too_large(&name)); }
            let size = bytes.len() as u64;
            Ok((name, Source::Bytes(bytes), size))
        }
        _ => bail!("{name}: give either a path or the file’s bytes, not both or neither."),
    }
}

/// Copy `files` into one new folder of the session's attachments folder.
/// All or nothing: one file refused refuses the call, and nothing is left.
pub fn store(session_id: &str, files: &[FileInput]) -> Result<Vec<FileRef>> {
    ensure!(files.len() <= MAX_FILES_PER_MESSAGE, "At most {MAX_FILES_PER_MESSAGE} files go with one message.");
    if files.is_empty() { return Ok(Vec::new()); }
    let admitted = files.iter().map(admit_input).collect::<Result<Vec<_>>>()?;
    let folder = new_folder(&session_folder(session_id)?)?;
    let written = (|| {
        let mut used = HashSet::new();
        let mut refs = Vec::with_capacity(admitted.len());
        for ((name, source, size), input) in admitted.into_iter().zip(files) {
            let name = unique(&name, &mut used);
            let to = folder.join(&name);
            match source {
                Source::Path(from) => { std::fs::copy(&from, &to).with_context(|| format!("copy {name}"))?; }
                Source::Bytes(bytes) => std::fs::write(&to, bytes).with_context(|| format!("write {name}"))?,
            }
            let media_type = input.media_type.clone().filter(|m| !m.is_empty()).or_else(|| media_type_of(&to));
            refs.push(FileRef { path: to.to_string_lossy().into_owned(), name, media_type, size: Some(size) });
        }
        Ok(refs)
    })();
    if written.is_err() { let _ = std::fs::remove_dir_all(&folder); }
    written
}

/// Size and media type of each path, in the order given. One bad path is
/// marked `unreadable`; it never fails the rest.
pub fn inspect(paths: &[String]) -> Vec<FileFacts> {
    paths.iter().map(|path| {
        let p = Path::new(path);
        let name = base_name(path).to_string();
        let meta = std::fs::metadata(p).ok().filter(|meta| meta.is_file());
        let readable = meta.is_some() && std::fs::File::open(p).is_ok();
        FileFacts {
            path: path.clone(),
            name,
            size: meta.as_ref().map_or(0, |meta| meta.len()),
            media_type: media_type_of(p),
            unreadable: !readable,
        }
    }).collect()
}

/// The canonical folder every session's attachments are under.
fn attachments_root() -> Result<PathBuf> {
    let root = store::root()?.join("attachments");
    std::fs::create_dir_all(&root)?;
    Ok(root.canonicalize()?)
}

/// Write a copy of a stored attachment to `to`, which the person chose in a
/// save dialog (so it may replace a file there). `path` must be inside an
/// attachments folder.
pub fn save_copy(path: &str, to: &str) -> Result<()> {
    let from = Path::new(path).canonicalize().with_context(|| format!("{} is no longer on this computer.", base_name(path)))?;
    ensure!(from.starts_with(attachments_root()?), "Only an attached file can be saved from here.");
    ensure!(from.is_file(), "{} is not a file.", base_name(path));
    std::fs::copy(&from, to).with_context(|| format!("save a copy to {to}"))?;
    Ok(())
}

/// The stored files a message is about to carry, checked to be this
/// session's and still there. `images` count toward the limit too.
pub(crate) fn admit_refs(session_id: &str, files: &[FileRef], images: usize) -> Result<Vec<FileRef>> {
    if files.is_empty() { return Ok(Vec::new()); }
    ensure!(files.len() + images <= MAX_FILES_PER_MESSAGE, "At most {MAX_FILES_PER_MESSAGE} files go with one message.");
    let folder = session_folder(session_id)?;
    files.iter().map(|file| {
        let shown = if file.name.is_empty() { base_name(&file.path) } else { &file.name };
        let path = Path::new(&file.path).canonicalize().with_context(|| format!("{shown} is no longer in this session’s attachments."))?;
        ensure!(path.starts_with(&folder) && path != folder, "{shown} is not one of this session’s attachments.");
        let meta = std::fs::metadata(&path)?;
        ensure!(meta.is_file(), "{shown} is not a file.");
        if is_reserved(base_name(&path.to_string_lossy())) { return Err(reserved(shown)); }
        let name = if file.name.is_empty() { base_name(&path.to_string_lossy()).to_string() } else { file.name.clone() };
        let media_type = file.media_type.clone().or_else(|| media_type_of(&path));
        Ok(FileRef { path: path.to_string_lossy().into_owned(), name, media_type, size: Some(meta.len()) })
    }).collect()
}

/// The prompt the agent is handed: `text`, a blank line, then the block of
/// attached paths, one per line. With no text it is only the block.
pub fn with_block(text: &str, files: &[FileRef]) -> String {
    if files.is_empty() { return text.to_string(); }
    let mut out = String::new();
    if !text.trim().is_empty() {
        out.push_str(text.trim_end());
        out.push_str("\n\n");
    }
    out.push_str(BLOCK_HEADER);
    for file in files {
        out.push('\n');
        out.push_str(&file.path);
    }
    out
}

/// A prompt as the agent got it, split back into the text the person typed
/// and the files attached to it: the last block of [`with_block`]'s shape
/// (the header alone on its line, at the start or after a blank line, then
/// one absolute path per line up to a blank line or the end). Anything after
/// the block, such as context the app appended, stays in the text.
pub fn split_block(text: &str) -> (String, Vec<FileRef>) {
    let mut starts: Vec<usize> = text.match_indices(BLOCK_HEADER).map(|(at, _)| at).collect();
    starts.reverse();
    for at in starts {
        let before = &text[..at];
        if !(before.is_empty() || before.ends_with("\n\n")) { continue; }
        let after = &text[at + BLOCK_HEADER.len()..];
        let Some(after) = after.strip_prefix('\n') else { continue };
        let (block, rest) = match after.find("\n\n") {
            Some(end) => (&after[..end], &after[end + 2..]),
            None => (after.trim_end_matches('\n'), ""),
        };
        let paths: Vec<&str> = block.split('\n').collect();
        if paths.is_empty() || !paths.iter().all(|p| !p.is_empty() && Path::new(p).is_absolute()) { continue; }
        let files = paths.into_iter().map(|path| {
            let p = Path::new(path);
            FileRef {
                path: path.to_string(),
                name: base_name(path).to_string(),
                media_type: media_type_of(p),
                size: std::fs::metadata(p).ok().filter(|meta| meta.is_file()).map(|meta| meta.len()),
            }
        }).collect();
        let typed = before.strip_suffix("\n\n").unwrap_or(before);
        let text = match (typed.is_empty(), rest.is_empty()) {
            (_, true) => typed.to_string(),
            (true, false) => rest.to_string(),
            (false, false) => format!("{typed}\n\n{rest}"),
        };
        return (text, files);
    }
    (text.to_string(), Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn bytes(name: &str, data: &[u8]) -> FileInput {
        FileInput { name: name.into(), path: None, data: Some(base64::engine::general_purpose::STANDARD.encode(data)), media_type: None }
    }

    fn at(name: &str, path: &Path) -> FileInput {
        FileInput { name: name.into(), path: Some(path.to_string_lossy().into_owned()), data: None, media_type: None }
    }

    fn folder_of(file: &FileRef) -> PathBuf {
        Path::new(&file.path).parent().unwrap().to_path_buf()
    }

    #[test]
    fn a_path_and_base64_bytes_are_stored_in_one_new_folder() {
        let _home = store::temp_home();
        let outside = tempfile::tempdir().unwrap();
        let picked = outside.path().join("pr-template.md");
        std::fs::write(&picked, "# Summary\n").unwrap();

        let stored = store("s1", &[at("pr-template.md", &picked), bytes("notes.txt", b"pasted")]).unwrap();

        assert_eq!(stored.len(), 2);
        let folder = folder_of(&stored[0]);
        assert_eq!(folder_of(&stored[1]), folder, "one call, one folder");
        assert_eq!(folder.parent().unwrap(), store::attachments_dir("s1").unwrap().canonicalize().unwrap());
        let leaf = folder.file_name().unwrap().to_str().unwrap();
        assert_eq!(leaf.len(), 6);
        assert!(leaf.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()), "{leaf}");
        assert_eq!(stored[0].name, "pr-template.md");
        assert_eq!(std::fs::read_to_string(&stored[0].path).unwrap(), "# Summary\n");
        assert_eq!(stored[0].size, Some(10));
        assert_eq!(std::fs::read(&stored[1].path).unwrap(), b"pasted");
        assert_eq!(stored[1].size, Some(6));
        assert!(Path::new(&stored[0].path).is_absolute());

        let again = store("s1", &[bytes("notes.txt", b"later")]).unwrap();
        assert_ne!(folder_of(&again[0]), folder, "each call makes a new folder");
        assert_eq!(std::fs::read(&stored[1].path).unwrap(), b"pasted", "an earlier file is never replaced");
    }

    #[test]
    fn a_name_is_its_last_segment_and_a_repeat_gets_a_number() {
        let _home = store::temp_home();
        let stored = store("s1", &[bytes("../../etc/report.csv", b"a"), bytes("C:\\Users\\x\\report.csv", b"b"), bytes("REPORT.csv", b"c"), bytes("README", b"d"), bytes("README", b"e")]).unwrap();
        let names: Vec<_> = stored.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["report.csv", "report (2).csv", "REPORT (3).csv", "README", "README (2)"]);
        let folder = folder_of(&stored[0]);
        assert!(stored.iter().all(|f| folder_of(f) == folder), "nothing escapes the new folder");
        assert_eq!(stored[0].media_type, media_type_of(Path::new("report.csv")), "the media type is the extension's");

        for bad in ["", "..", ".", "dir/", "  "] {
            assert!(store("s1", &[bytes(bad, b"x")]).is_err(), "{bad:?} is refused");
        }
    }

    #[test]
    fn a_reserved_name_is_refused_in_any_case() {
        let _home = store::temp_home();
        for name in ["terminalx.json", "TerminalX.JSON", "nested/terminalx-root-mirror.lock", "TERMINALX-CLAUDE-USAGE.json"] {
            let error = store("s1", &[bytes("fine.txt", b"ok"), bytes(name, b"{}")]).unwrap_err().to_string();
            assert!(error.contains("a name TerminalX uses"), "{name}: {error}");
        }
        assert!(!is_reserved("terminalx.copy.json"));
        let left: Vec<_> = std::fs::read_dir(store::attachments_dir("s1").unwrap()).unwrap().collect();
        assert!(left.is_empty(), "a refused call leaves no folder behind");
    }

    #[test]
    fn an_eleventh_file_is_refused() {
        let _home = store::temp_home();
        let ten: Vec<_> = (0..10).map(|i| bytes(&format!("f{i}.txt"), b"x")).collect();
        assert_eq!(store("s1", &ten).unwrap().len(), 10);
        let eleven: Vec<_> = (0..11).map(|i| bytes(&format!("f{i}.txt"), b"x")).collect();
        assert!(store("s1", &eleven).unwrap_err().to_string().contains("At most 10 files"));
    }

    #[test]
    fn an_oversized_file_is_refused_by_name() {
        let _home = store::temp_home();
        let outside = tempfile::tempdir().unwrap();
        let big = outside.path().join("dump.bin");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        let error = store("s1", &[at("dump.bin", &big)]).unwrap_err().to_string();
        assert!(error.contains("dump.bin") && error.contains("25 MB"), "{error}");

        let exactly = outside.path().join("edge.bin");
        std::fs::File::create(&exactly).unwrap().set_len(MAX_ATTACHMENT_BYTES).unwrap();
        assert_eq!(store("s1", &[at("edge.bin", &exactly)]).unwrap()[0].size, Some(MAX_ATTACHMENT_BYTES));

        let encoded = bytes("big.bin", &vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1]);
        assert!(store("s1", &[encoded]).unwrap_err().to_string().contains("big.bin"));
    }

    #[test]
    fn a_path_must_be_a_regular_file_and_exactly_one_source_is_given() {
        let _home = store::temp_home();
        let outside = tempfile::tempdir().unwrap();
        assert!(store("s1", &[at("folder", outside.path())]).is_err());
        assert!(store("s1", &[at("gone.txt", &outside.path().join("gone.txt"))]).is_err());
        let both = FileInput { name: "x.txt".into(), path: Some("/tmp/x".into()), data: Some("eA==".into()), media_type: None };
        assert!(store("s1", &[both]).is_err());
        let neither = FileInput { name: "x.txt".into(), path: None, data: None, media_type: None };
        assert!(store("s1", &[neither]).is_err());
        assert!(store("../escape", &[bytes("x.txt", b"x")]).is_err());
    }

    #[test]
    fn inspect_reports_each_path_in_order_without_failing_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("spec.pdf");
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();
        let paths = vec![pdf.to_string_lossy().into_owned(), dir.path().to_string_lossy().into_owned(), dir.path().join("missing.txt").to_string_lossy().into_owned()];
        let facts = inspect(&paths);
        assert_eq!(facts.len(), 3);
        assert_eq!((facts[0].name.as_str(), facts[0].size, facts[0].unreadable), ("spec.pdf", 8, false));
        assert_eq!(facts[0].media_type, media_type_of(&pdf));
        assert!(facts[1].unreadable, "a folder is never attached");
        assert!(facts[2].unreadable);
        assert_eq!(facts[2].path, paths[2]);
        let json = serde_json::to_value(&facts[0]).unwrap();
        assert!(json.get("unreadable").is_none() && json["size"] == 8);
    }

    #[test]
    fn a_copy_is_saved_only_from_an_attachments_folder() {
        let _home = store::temp_home();
        let stored = store("s1", &[bytes("log.txt", b"line")]).unwrap();
        let out = tempfile::tempdir().unwrap();
        let to = out.path().join("saved.txt");
        std::fs::write(&to, "old").unwrap();
        save_copy(&stored[0].path, &to.to_string_lossy()).unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "line", "the chosen file is replaced");

        let elsewhere = out.path().join("secret.txt");
        std::fs::write(&elsewhere, "no").unwrap();
        assert!(save_copy(&elsewhere.to_string_lossy(), &out.path().join("x").to_string_lossy()).is_err());
        let sneaky = format!("{}/../../../{}", folder_of(&stored[0]).display(), elsewhere.display());
        assert!(save_copy(&sneaky, &out.path().join("y").to_string_lossy()).is_err());
    }

    #[test]
    fn a_message_may_only_carry_its_own_sessions_files() {
        let _home = store::temp_home();
        let mine = store("s1", &[bytes("a.md", b"a")]).unwrap();
        let theirs = store("s2", &[bytes("b.md", b"b")]).unwrap();
        assert_eq!(admit_refs("s1", &mine, 0).unwrap()[0].path, mine[0].path);
        assert!(admit_refs("s1", &theirs, 0).unwrap_err().to_string().contains("not one of this session’s attachments"));

        let outside = tempfile::tempdir().unwrap();
        let loose = outside.path().join("a.md");
        std::fs::write(&loose, "a").unwrap();
        let loose = FileRef { path: loose.to_string_lossy().into_owned(), name: "a.md".into(), media_type: None, size: None };
        assert!(admit_refs("s1", &[loose], 0).is_err());
        let climbing = FileRef { path: format!("{}/../../s2/{}", folder_of(&mine[0]).display(), Path::new(&theirs[0].path).strip_prefix(store::attachments_dir("s2").unwrap().canonicalize().unwrap()).unwrap().display()), ..mine[0].clone() };
        assert!(admit_refs("s1", &[climbing], 0).is_err(), "a path that climbs out is judged where it lands");
        std::fs::remove_file(&mine[0].path).unwrap();
        assert!(admit_refs("s1", &mine, 0).is_err(), "a file that is gone is refused");

        let ten = store("s1", &(0..10).map(|i| bytes(&format!("{i}.txt"), b"x")).collect::<Vec<_>>()).unwrap();
        assert!(admit_refs("s1", &ten, 1).unwrap_err().to_string().contains("At most 10"), "images count toward the ten");
    }

    #[test]
    fn the_block_follows_the_text_and_comes_off_again() {
        let file = |path: &str| FileRef { path: path.into(), name: base_name(path).into(), media_type: None, size: None };
        let files = [file("/h/attachments/s/k3f9qa/pr-template.md"), file("/h/attachments/s/k3f9qa/notes (2).txt")];
        let agent = with_block("Review this", &files);
        assert_eq!(agent, "Review this\n\nAttached files:\n/h/attachments/s/k3f9qa/pr-template.md\n/h/attachments/s/k3f9qa/notes (2).txt");
        assert_eq!(with_block("", &files), "Attached files:\n/h/attachments/s/k3f9qa/pr-template.md\n/h/attachments/s/k3f9qa/notes (2).txt");
        assert_eq!(with_block("plain", &[]), "plain");

        let (text, back) = split_block(&agent);
        assert_eq!(text, "Review this");
        assert_eq!(back.iter().map(|f| (f.path.as_str(), f.name.as_str())).collect::<Vec<_>>(),
            [("/h/attachments/s/k3f9qa/pr-template.md", "pr-template.md"), ("/h/attachments/s/k3f9qa/notes (2).txt", "notes (2).txt")]);
        assert_eq!(split_block(&with_block("", &files)).0, "");
        // Context the app appends after the block stays with the text.
        let (text, back) = split_block(&format!("{agent}\n\nThe user reverted a.txt."));
        assert_eq!((text.as_str(), back.len()), ("Review this\n\nThe user reverted a.txt.", 2));
        // The person's own words are left alone.
        for typed in ["Attached files: none", "see\nAttached files:\n/a", "Attached files:\nnot a path", "Attached files:\n"] {
            assert_eq!(split_block(typed), (typed.to_string(), Vec::new()), "{typed:?}");
        }
    }

    #[test]
    fn a_cli_transcript_gives_back_the_typed_text_and_the_files() {
        use crate::events::Payload;
        let _home = store::temp_home();
        let stored = store("s1", &[bytes("pr-template.md", b"# Summary\n")]).unwrap();
        let prompt = with_block("Use this template", &stored);
        let content = serde_json::to_string(&prompt).unwrap();
        let claude = format!(r#"{{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u-1","userType":"external","cwd":"/w","sessionId":"s","origin":{{"kind":"human"}},"message":{{"role":"user","content":{content}}}}}"#);
        let codex = format!(r#"{{"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"UserMessage","id":"user-1","content":[{{"type":"text","text":{content},"text_elements":[]}}]}}}}}}"#);
        for (cli, decoded) in [
            ("claude", { let mut out = Vec::new(); crate::harness::claude::transcript::decode_line(&claude, &HashSet::new(), &mut out); out }),
            ("codex", { let mut out = Vec::new(); crate::harness::codex::rollout::decode_line(&codex, &HashSet::new(), &mut out); out }),
        ] {
            let Some(Payload::UserMessage { text, files, .. }) = decoded.into_iter().find(|p| matches!(p, Payload::UserMessage { .. })) else { panic!("{cli}: no prompt") };
            assert_eq!(text, "Use this template", "{cli}");
            assert_eq!(files.len(), 1, "{cli}");
            assert_eq!((files[0].path.as_str(), files[0].name.as_str(), files[0].size), (stored[0].path.as_str(), "pr-template.md", Some(10)), "{cli}");
        }
    }
}
