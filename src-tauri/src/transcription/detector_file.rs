//! File readiness only: a verified checksum does not prove native loading or speech detection.
//! Kept separate from runtime NoiseStatus so failures retain their existing semantics.
use serde::Serialize;
#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::io::Read;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Readiness {
    Missing,
    Invalid,
    VerifiedFile,
    Error,
}

pub(super) fn inspect() -> Readiness {
    // Resolve the existing store convention without creating directories for a read.
    let root = crate::store::state_home_env().map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".raccoon")));
    let Some(root) = root else { return Readiness::Error };
    let spec = &super::catalog::DETECTOR;
    inspect_path(&root.join("models").join(spec.id).join(spec.filename), spec.size_bytes, spec.sha256)
}

// Use the catalog's existing size/hash pins and the same bounded, no-follow file
// validation as runtime. Do not depend on the macOS-only native detector crate
// or invoke its parser merely to display file readiness.
#[cfg(unix)]
fn inspect_path(path: &Path, size: u64, hash: &str) -> Readiness {
    use std::os::unix::fs::OpenOptionsExt;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() => return Readiness::Invalid,
        Ok(_) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Readiness::Missing,
        Err(_) => return Readiness::Error,
    }
    let file = match std::fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(path) {
        Ok(file) => file,
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Readiness::Invalid,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Readiness::Missing,
        Err(_) => return Readiness::Error,
    };
    match file.metadata() {
        Ok(meta) if !meta.is_file() || meta.len() != size => return Readiness::Invalid,
        Ok(_) => {},
        Err(_) => return Readiness::Error,
    }
    let mut bytes = Vec::new();
    if file.take(size.saturating_add(1)).read_to_end(&mut bytes).is_err() {
        return Readiness::Error;
    }
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != hash {
        Readiness::Invalid
    } else {
        Readiness::VerifiedFile
    }
}

#[cfg(not(unix))]
fn inspect_path(_path: &Path, _size: u64, _hash: &str) -> Readiness {
    // No native dictation support here; do not claim a no-follow check occurred.
    Readiness::Error
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    const HASH: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn readiness_wire_names_do_not_claim_runtime_classification() {
        for (status, expected) in [
            (Readiness::Missing, "missing"),
            (Readiness::Invalid, "invalid"),
            (Readiness::VerifiedFile, "verifiedFile"),
            (Readiness::Error, "error"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), serde_json::json!(expected));
        }
    }

    #[test]
    fn distinguishes_missing_invalid_verified_and_io_error_without_native_loading() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture");
        assert_eq!(inspect_path(&path, 3, HASH), Readiness::Missing);
        for bytes in [b"ab".as_slice(), b"abcd".as_slice(), b"abd".as_slice()] {
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(inspect_path(&path, 3, HASH), Readiness::Invalid);
        }
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(inspect_path(&path, 3, HASH), Readiness::VerifiedFile);
        assert_eq!(inspect_path(&path.join("child"), 3, HASH), Readiness::Error);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(inspect_path(&path, 3, HASH), Readiness::Missing);
    }

    #[test]
    fn rejects_symlinks_directories_and_fifo_without_reading_them() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        std::fs::write(&target, b"abc").unwrap();
        let link = temp.path().join("link");
        symlink(&target, &link).unwrap();
        assert_eq!(inspect_path(&link, 3, HASH), Readiness::Invalid);
        std::fs::remove_file(&target).unwrap();
        assert_eq!(inspect_path(&link, 3, HASH), Readiness::Invalid);
        assert_eq!(inspect_path(temp.path(), 3, HASH), Readiness::Invalid);
        let fifo = temp.path().join("fifo");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: owned temporary path, valid NUL-terminated name.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(inspect_path(&fifo, 3, HASH), Readiness::Invalid);
    }
}
