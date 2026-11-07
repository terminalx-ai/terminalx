//! Bounded, binary-safe reads of immutable diff revisions. No text decoding,
//! external diff driver, workspace-wide asset scope, or temporary files.
use anyhow::{bail, ensure, Context, Result};
use base64::Engine;
use serde::Serialize;
use std::{
    io::Read,
    path::{Component, Path},
    process::Command,
};

#[derive(Serialize)]
pub struct MediaContent {
    data: String,
    mime: String,
}

pub fn read(
    cwd: &Path,
    path: &str,
    tree: Option<&str>,
    limit: usize,
) -> Result<Option<MediaContent>> {
    ensure!(
        !path.is_empty()
            && !path.contains('\0')
            && Path::new(path)
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
        "Invalid repository-relative media path"
    );
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml".to_owned(),
        "pdf" => "application/pdf".to_owned(),
        _ => crate::media_types::media_type(Path::new(path))
            .filter(|m| m.mime.starts_with("image/"))
            .context("Unsupported diff media format")?
            .mime
            .clone(),
    };
    let bytes = if let Some(tree) = tree {
        ensure!(
            (7..=64).contains(&tree.len()) && tree.bytes().all(|c| c.is_ascii_hexdigit()),
            "Invalid tree id"
        );
        crate::git::run(cwd, &["cat-file", "-e", &format!("{tree}^{{tree}}")])?;
        let spec = format!("{tree}:{path}");
        let mut command =
            Command::new(crate::binpath::resolve("git").unwrap_or_else(|| "git".into()));
        command.current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0");
        // A missing side of an addition/deletion is distinct from a corrupt tree.
        let kind = command.args(["cat-file", "-t", &spec]).output()?;
        if !kind.status.success() {
            return Ok(None);
        }
        ensure!(kind.stdout == b"blob\n", "Not a regular media blob");
        let size: usize = crate::git::run(cwd, &["cat-file", "-s", &spec])?
            .trim()
            .parse()?;
        ensure!(
            size <= limit,
            "Media preview exceeds the {} KiB limit",
            limit / 1024
        );
        let output = Command::new(crate::binpath::resolve("git").unwrap_or_else(|| "git".into()))
            .current_dir(cwd)
            .args(["cat-file", "blob", &spec])
            .output()?;
        ensure!(output.status.success(), "Could not read media revision");
        output.stdout
    } else {
        let root = cwd.canonicalize()?;
        let resolved = match root.join(path).canonicalize() {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        ensure!(
            resolved.starts_with(root),
            "Media path is outside the repository"
        );
        ensure!(
            std::fs::metadata(&resolved)?.is_file(),
            "Not a regular media file"
        );
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // A replacement FIFO must not block a preview task, and a replaced
            // final symlink must not turn a checked path into an outside read.
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        let file = options.open(&resolved)?;
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "Not a regular media file");
        ensure!(
            metadata.len() <= limit as u64,
            "Media preview exceeds the {} KiB limit",
            limit / 1024
        );
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        bytes
    };
    if bytes.len() > limit {
        bail!("Media preview exceeds the {} KiB limit", limit / 1024);
    }
    Ok(Some(MediaContent {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run;

    #[test]
    fn reads_binary_revisions_missing_sides_and_limits_without_touching_files() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path();
        run(cwd, &["init", "-q"]).unwrap();
        for path in ["透明 #1.PNG", "document.pdf", "vector.svg"] {
            std::fs::write(cwd.join(path), b"old\0\xff").unwrap();
        }
        run(cwd, &["add", "."]).unwrap();
        let base = run(cwd, &["write-tree"]).unwrap();
        let base = base.trim();
        std::fs::rename(cwd.join("透明 #1.PNG"), cwd.join("renamed.png")).unwrap();
        std::fs::write(cwd.join("renamed.png"), b"new\0\xfe").unwrap();
        run(cwd, &["add", "-A"]).unwrap();
        let head = run(cwd, &["write-tree"]).unwrap();
        let original = read(cwd, "透明 #1.PNG", Some(base), 32).unwrap().unwrap();
        let changed = read(cwd, "renamed.png", Some(head.trim()), 32)
            .unwrap()
            .unwrap();
        assert_eq!(original.mime, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(original.data)
                .unwrap(),
            b"old\0\xff"
        );
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(changed.data)
                .unwrap(),
            b"new\0\xfe"
        );
        assert!(read(cwd, "renamed.png", Some(base), 32).unwrap().is_none());
        assert!(read(cwd, "透明 #1.PNG", None, 32).unwrap().is_none());
        assert_eq!(
            read(cwd, "document.pdf", Some(base), 32)
                .unwrap()
                .unwrap()
                .mime,
            "application/pdf"
        );
        assert_eq!(
            read(cwd, "vector.svg", Some(base), 32)
                .unwrap()
                .unwrap()
                .mime,
            "image/svg+xml"
        );
        assert!(read(cwd, "renamed.png", Some(head.trim()), 2).is_err());
        assert!(read(cwd, "renamed.png", None, 2).is_err());
        assert!(read(cwd, "renamed.png", Some("--help"), 32).is_err());
        assert!(read(
            cwd,
            "renamed.png",
            Some("1111111111111111111111111111111111111111"),
            32
        )
        .is_err());
        assert!(read(cwd, "../outside.png", None, 32).is_err());
        assert!(read(cwd, "/outside.png", Some(base), 32).is_err());
        assert_eq!(
            std::fs::read(cwd.join("renamed.png")).unwrap(),
            b"new\0\xfe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn live_media_cannot_follow_a_symlink_outside_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.png"), b"secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.png"),
            dir.path().join("leak.png"),
        )
        .unwrap();
        assert!(read(dir.path(), "leak.png", None, 1024).is_err());
        assert!(Command::new("mkfifo")
            .arg(dir.path().join("pipe.png"))
            .status()
            .unwrap()
            .success());
        assert!(read(dir.path(), "pipe.png", None, 1024).is_err());
    }
}
