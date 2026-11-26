//! Fake guest and engine helpers that tests execute (PRO-513).
//!
//! macOS assesses every newly written executable on its first exec. On a
//! developer Mac that first exec costs about a second and syspolicyd serves it
//! one at a time machine-wide, so a test that writes a fresh fake helper and
//! runs it under a product deadline (the 5 s engine inspect, the setup actor's
//! wait) queues behind every other test doing the same. At 16 test threads
//! that queue outgrew the deadlines. The assessment is cached per file: a hard
//! link to a helper that has already run starts in milliseconds, while a copy
//! with the same bytes is assessed again.
//!
//! So each distinct helper text is written once into a content-addressed
//! directory, run once here, outside any product deadline, and then
//! hard-linked into the calling test's own directory. The product still runs
//! the test's own path, with the test's `$HOME`, `__file__` and side files, so
//! what each helper observes and answers is unchanged. The shared file is
//! read-only, so a test cannot rewrite another test's helper through its link.
use std::collections::BTreeSet;
use std::io::ErrorKind;
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

const MODE: u32 = 0o500;

/// Place the executable helper `text` at `at` (a path in the test's own
/// temporary directory, which must not exist yet).
pub(crate) fn install(at: &Path, text: &str) {
    let shared = shared(text);
    std::fs::hard_link(&shared, at).unwrap_or_else(|error| {
        panic!(
            "link fake helper {} to {}: {error}",
            shared.display(),
            at.display()
        )
    });
}

/// The shared, already-executed copy of `text`.
fn shared(text: &str) -> PathBuf {
    static READY: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    let digest = super::journal::digest(text.as_bytes());
    let path = directory().join(&digest);
    // Held across the write and the first exec: tests that reach here wait in
    // setup, where no product deadline runs.
    let mut ready = READY.lock().unwrap_or_else(|poison| poison.into_inner());
    if ready.contains(&digest) {
        return path;
    }
    if !path.exists() {
        // Write beside, then link into place: a concurrent test process either
        // wins the link or finds the same complete content already there.
        let partial = tempfile::NamedTempFile::new_in(directory()).unwrap();
        std::fs::write(partial.path(), text).unwrap();
        std::fs::set_permissions(partial.path(), std::fs::Permissions::from_mode(MODE)).unwrap();
        match std::fs::hard_link(partial.path(), &path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => panic!("place fake helper {}: {error}", path.display()),
        }
    }
    let meta = std::fs::symlink_metadata(&path).unwrap();
    assert!(
        meta.file_type().is_file()
            && meta.mode() & 0o777 == MODE
            && meta.uid() == unsafe { libc::geteuid() }
            && std::fs::read(&path).unwrap() == text.as_bytes(),
        "fake helper {} is not the expected read-only content",
        path.display()
    );
    // Pay the first-exec assessment now. The helper runs in an empty scratch
    // home and directory with no arguments and no input; its answer is
    // irrelevant, only that the file has been executed once.
    let scratch = tempfile::tempdir().unwrap();
    Command::new(&path)
        .env("HOME", scratch.path())
        .current_dir(scratch.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap_or_else(|error| panic!("first exec of fake helper {}: {error}", path.display()));
    ready.insert(digest);
    path
}

/// One directory per user beside the tests' own temporary directories (the
/// same filesystem, so hard links work). Content-addressed, so it stays
/// bounded and later test processes reuse already-assessed helpers.
fn directory() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("terminalx-fake-helpers-{}", unsafe {
        libc::geteuid()
    }));
    match std::fs::create_dir(&dir) {
        Ok(()) => std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap(),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => panic!("create {}: {error}", dir.display()),
    }
    let meta = std::fs::symlink_metadata(&dir).unwrap();
    assert!(
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
        "{} must be a private directory owned by this user",
        dir.display()
    );
    dir
}
