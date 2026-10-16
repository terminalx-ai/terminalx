//! Where the helper runs from (#480).
//!
//! macOS charges a Screen Recording check to the outermost app bundle that
//! contains the executable, whatever the responsibility disclaim says and
//! however the process was started. tccd logs it as `BUNDLE_ATTRIBUTION: …
//! resolves to attributed bundle: …/TerminalX.app/` for a helper in
//! `Contents/Resources`, and the same for `Contents/Helpers`,
//! `Contents/Library/LoginItems`, `Contents/XPCServices`, `Contents/MacOS`
//! and `Contents/Frameworks`. Accessibility, by contrast, is charged to the
//! disclaimed helper itself. So a helper inside TerminalX.app can take
//! screenshots only while TerminalX holds Screen Recording, which PRO-90
//! forbids, and its Grant button asks for TerminalX.
//!
//! The app therefore runs a copy of the bundled helper from outside its own
//! bundle, under Application Support. The copy is the same signed code, so
//! its TCC rows are the helper's, and the peer rules are the helper's own:
//! they do not depend on where it lives.
//!
//! This module only keeps the copy current: it is compared with the bundled
//! helper, file by file, before every helper start and at most every ten
//! seconds otherwise, and replaced whenever they differ. It is not what makes
//! the copy safe. Anything the person's user can write to, an agent can too,
//! so the app never trusts the copy's files: every process started from it is
//! checked against the bundled helper's signature and exact cdhash before it
//! runs (see `code_identity`).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The outermost `.app` directory that contains `helper` (not counting
/// `helper` itself): the bundle macOS would charge its screen captures to.
pub fn enclosing_app(helper: &Path) -> Option<PathBuf> {
    helper
        .ancestors()
        .skip(1)
        .filter(|dir| dir.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app")))
        .last()
        .map(Path::to_path_buf)
}

/// Where the copy of `bundled` lives under `base`: one folder per bundled
/// location, so two builds on one Mac (Dev builds in several worktrees)
/// never replace each other's copy.
pub fn copy_location(base: &Path, bundled: &Path) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    let digest = Sha256::digest(bundled.as_os_str().as_bytes());
    let key: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    let name = bundled.file_name().unwrap_or(std::ffi::OsStr::new(super::HELPER_APP_NAME));
    base.join(key).join(name)
}

/// The helper to run for `bundled`. A helper that is not inside another app
/// runs where it is. One inside an app runs from its copy under `base`,
/// made or brought up to date first.
pub fn helper_to_run(bundled: &Path, base: &Path) -> std::io::Result<PathBuf> {
    if enclosing_app(bundled).is_none() {
        return Ok(bundled.to_path_buf());
    }
    let copy = copy_location(base, bundled);
    if enclosing_app(&copy).is_some() {
        return Err(std::io::Error::other(format!(
            "{} is itself inside an app, where macOS would charge screen captures to that app",
            copy.display()
        )));
    }
    install(bundled, &copy)?;
    Ok(copy)
}

/// One install at a time in this process: the settings window, the CLI and
/// a helper start can all ask at once. Other processes (a second TerminalX)
/// are kept out by a lock file in the base folder.
static INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The file in each copy's folder that names the bundled helper it copies,
/// so copies whose app is gone can be removed.
const SOURCE_FILE: &str = "source";

/// Hold an exclusive `flock` on `base/.lock` until dropped.
struct InstallLock(std::fs::File);

impl InstallLock {
    fn take(base: &Path) -> std::io::Result<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(libc::O_NOFOLLOW)
            .open(base.join(".lock"))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self(file))
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// A copy whose bundled helper no longer exists (the app was moved, deleted
/// or ran from an App Translocation mount that is gone), or whose folder does
/// not say what it copies. Folders are left alone for a minute, in case
/// another process is creating one.
fn sweep_orphaned_copies(base: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || entry.file_name().to_string_lossy().starts_with('.') || !is_stale(&path) {
            continue;
        }
        let source = std::fs::read_to_string(path.join(SOURCE_FILE)).ok();
        let orphaned = match source {
            Some(source) => {
                let source = Path::new(source.trim());
                source.as_os_str().to_string_lossy().contains("/AppTranslocation/") || std::fs::symlink_metadata(source).is_err()
            }
            None => true,
        };
        if orphaned {
            let _ = remove_any(&path);
        }
    }
}

/// Make `copy` the same tree as `bundled`. A copy that already matches is
/// left alone; otherwise a new one is written beside it and renamed into
/// place, so a helper still running from the old one keeps its files.
fn install(bundled: &Path, copy: &Path) -> std::io::Result<()> {
    let _guard = INSTALL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let holder = copy.parent().ok_or_else(|| std::io::Error::other("the helper copy has no folder"))?;
    let base = holder.parent().ok_or_else(|| std::io::Error::other("the helper copy has no base folder"))?;
    ensure_plain_dirs(holder)?;
    let _lock = InstallLock::take(base)?;
    sweep_leftovers(holder);
    sweep_orphaned_copies(base, holder);
    record_source(holder, bundled)?;
    if same_tree(bundled, copy)? {
        return Ok(());
    }
    let staging = holder.join(format!(".staging-{}", uuid::Uuid::now_v7().simple()));
    let written = copy_tree(bundled, &staging);
    if let Err(error) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let retired = holder.join(format!(".old-{}", uuid::Uuid::now_v7().simple()));
    if std::fs::symlink_metadata(copy).is_ok() {
        if let Err(error) = std::fs::rename(copy, &retired) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    }
    let placed = std::fs::rename(&staging, copy);
    let _ = remove_any(&retired);
    if let Err(error) = placed {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    // Written and placed, but compare again: nothing else may have been put
    // in its place between the two.
    if same_tree(bundled, copy)? {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("{} changed while it was being installed", copy.display())))
    }
}

/// Say which bundled helper this folder's copy is of.
fn record_source(holder: &Path, bundled: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let file = holder.join(SOURCE_FILE);
    let wanted = bundled.as_os_str().as_bytes();
    if std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_file())
        && std::fs::read(&file).is_ok_and(|current| current == wanted)
    {
        return Ok(());
    }
    let _ = remove_any(&file);
    let staging = holder.join(format!(".source-{}", uuid::Uuid::now_v7().simple()));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&staging)?.write_all(wanted)?;
    std::fs::rename(&staging, &file)
}

/// Create `dir` and its parents, and refuse if any of the folders this
/// module owns (the copy's folder and the one above it) is a symlink.
fn ensure_plain_dirs(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for owned in dir.ancestors().take(2) {
        let meta = std::fs::symlink_metadata(owned)?;
        if !meta.file_type().is_dir() {
            return Err(std::io::Error::other(format!("{} is not a plain folder", owned.display())));
        }
    }
    Ok(())
}

/// Staging and retired copies left by a crash or a concurrent start.
fn sweep_leftovers(holder: &Path) {
    let Ok(entries) = std::fs::read_dir(holder) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".old-") || ((name.starts_with(".staging-") || name.starts_with(".source-")) && is_stale(&entry.path())) {
            let _ = remove_any(&entry.path());
        }
    }
}

/// A staging folder another thread or process may still be writing is left
/// for a minute.
fn is_stale(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > std::time::Duration::from_secs(60))
}

/// Remove a file, a symlink (never what it points to) or a folder tree.
fn remove_any(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Copy a bundle without extended attributes: a signed bundle's files are
/// exactly its contents and modes, and Finder detritus would break the
/// signature. Every directory and file is created new.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::symlink_metadata(from)?;
    let kind = meta.file_type();
    if kind.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(meta.permissions().mode() & 0o7777))
    } else if kind.is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)
    } else if kind.is_file() {
        let mut source = std::fs::File::open(from)?;
        let mut target = std::fs::OpenOptions::new().write(true).create_new(true).open(to)?;
        std::io::copy(&mut source, &mut target)?;
        target.flush()?;
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(meta.permissions().mode() & 0o7777))
    } else {
        Err(std::io::Error::other(format!("{} is not a file, folder or symlink", from.display())))
    }
}

/// Whether `copy` holds exactly what `bundled` holds: the same names, kinds,
/// modes, file contents and symlink targets, and nothing more. A missing
/// copy is not the same.
fn same_tree(bundled: &Path, copy: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;
    let source = std::fs::symlink_metadata(bundled)?;
    let Ok(target) = std::fs::symlink_metadata(copy) else {
        return Ok(false);
    };
    let (source_kind, target_kind) = (source.file_type(), target.file_type());
    if source_kind.is_dir() != target_kind.is_dir()
        || source_kind.is_symlink() != target_kind.is_symlink()
        || source_kind.is_file() != target_kind.is_file()
    {
        return Ok(false);
    }
    if source_kind.is_symlink() {
        return Ok(std::fs::read_link(bundled)? == std::fs::read_link(copy)?);
    }
    if source.permissions().mode() & 0o7777 != target.permissions().mode() & 0o7777 {
        return Ok(false);
    }
    if source_kind.is_file() {
        return Ok(source.len() == target.len() && same_contents(bundled, copy)?);
    }
    let names = |dir: &Path| -> std::io::Result<Vec<std::ffi::OsString>> {
        let mut names = std::fs::read_dir(dir)?.map(|e| e.map(|e| e.file_name())).collect::<Result<Vec<_>, _>>()?;
        names.sort();
        Ok(names)
    };
    let source_names = names(bundled)?;
    if source_names != names(copy)? {
        return Ok(false);
    }
    for name in source_names {
        if !same_tree(&bundled.join(&name), &copy.join(&name))? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn same_contents(a: &Path, b: &Path) -> std::io::Result<bool> {
    let (mut a, mut b) = (std::fs::File::open(a)?, std::fs::File::open(b)?);
    let (mut left, mut right) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let read = a.read(&mut left)?;
        if read == 0 {
            return Ok(b.read(&mut right[..1])? == 0);
        }
        let mut filled = 0;
        while filled < read {
            let more = b.read(&mut right[filled..read])?;
            if more == 0 {
                return Ok(false);
            }
            filled += more;
        }
        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn write(path: &Path, text: &str, mode: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A helper bundle inside an app, the way a release ships it.
    fn shipped(root: &Path) -> PathBuf {
        let helper = root.join("TerminalX.app/Contents/Resources").join(crate::computer::HELPER_APP_NAME);
        write(&helper.join("Contents/Info.plist"), "<plist/>", 0o644);
        write(&helper.join("Contents/MacOS").join(crate::computer::HELPER_EXECUTABLE_NAME), "binary v1", 0o755);
        write(&helper.join("Contents/_CodeSignature/CodeResources"), "sig v1", 0o644);
        helper
    }

    #[test]
    fn macos_charges_screen_capture_to_the_outermost_app_around_the_helper() {
        let nested = Path::new("/Applications/TerminalX.app/Contents/Resources/TerminalX Computer Use Helper.app");
        assert_eq!(enclosing_app(nested), Some(PathBuf::from("/Applications/TerminalX.app")));
        let deeper = Path::new("/A/Outer.app/Contents/Frameworks/Mid.app/Contents/Library/LoginItems/H.app");
        assert_eq!(enclosing_app(deeper), Some(PathBuf::from("/A/Outer.app")));
        assert_eq!(enclosing_app(Path::new("/repo/native/computer-use-macos/.build/release-dev/H.app")), None);
        assert_eq!(enclosing_app(Path::new("/Users/me/Library/Application Support/TerminalX/computer-use-helper/k/H.app")), None);
    }

    #[test]
    fn a_helper_that_is_not_inside_an_app_runs_where_it_is_and_nothing_is_copied() {
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join(".build/release-dev/H.app");
        write(&helper.join("Contents/Info.plist"), "<plist/>", 0o644);
        let base = dir.path().join("support");
        assert_eq!(helper_to_run(&helper, &base).unwrap(), helper);
        assert!(!base.exists());
    }

    #[test]
    fn a_shipped_helper_runs_from_an_identical_copy_outside_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let helper = shipped(dir.path());
        let base = dir.path().join("support");
        let run = helper_to_run(&helper, &base).unwrap();
        assert_eq!(run, copy_location(&base, &helper));
        assert_eq!(enclosing_app(&run), None);
        assert_eq!(run.file_name(), helper.file_name(), "System Settings shows the same name");
        assert!(same_tree(&helper, &run).unwrap());
        let exe = run.join("Contents/MacOS").join(crate::computer::HELPER_EXECUTABLE_NAME);
        assert_eq!(std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o755);
        // Asked again, the same copy is used.
        assert_eq!(helper_to_run(&helper, &base).unwrap(), run);
    }

    #[test]
    fn an_update_or_a_changed_copy_is_replaced_by_the_bundled_helper() {
        let dir = tempfile::tempdir().unwrap();
        let helper = shipped(dir.path());
        let base = dir.path().join("support");
        let run = helper_to_run(&helper, &base).unwrap();
        let exe = |app: &Path| app.join("Contents/MacOS").join(crate::computer::HELPER_EXECUTABLE_NAME);

        // TerminalX was updated.
        write(&exe(&helper), "binary v2", 0o755);
        helper_to_run(&helper, &base).unwrap();
        assert_eq!(std::fs::read_to_string(exe(&run)).unwrap(), "binary v2");

        // Something wrote into the copy, added a file, or changed a mode.
        write(&exe(&run), "something else", 0o755);
        write(&run.join("Contents/MacOS/extra"), "x", 0o755);
        std::fs::set_permissions(run.join("Contents/Info.plist"), std::fs::Permissions::from_mode(0o666)).unwrap();
        helper_to_run(&helper, &base).unwrap();
        assert!(same_tree(&helper, &run).unwrap());

        // The copy's executable was swapped for a symlink to something else.
        std::fs::remove_file(exe(&run)).unwrap();
        std::os::unix::fs::symlink("/bin/sh", exe(&run)).unwrap();
        helper_to_run(&helper, &base).unwrap();
        assert!(same_tree(&helper, &run).unwrap());
        assert!(std::fs::symlink_metadata(exe(&run)).unwrap().file_type().is_file());

        // Nothing is left beside the copy.
        let holder = run.parent().unwrap();
        let mut names: Vec<_> = std::fs::read_dir(holder).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, vec![run.file_name().unwrap().to_str().unwrap().to_owned(), SOURCE_FILE.to_owned()]);
    }

    #[test]
    fn a_symlink_where_the_copy_would_go_is_refused_and_nothing_is_written_through_it() {
        let dir = tempfile::tempdir().unwrap();
        let helper = shipped(dir.path());
        let base = dir.path().join("support");
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let holder = copy_location(&base, &helper).parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&base).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &holder).unwrap();
        assert!(helper_to_run(&helper, &base).is_err());
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    }

    #[test]
    fn a_copy_location_inside_an_app_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let helper = shipped(dir.path());
        let base = dir.path().join("Other.app/Contents/Resources");
        assert!(helper_to_run(&helper, &base).is_err());
    }

    #[test]
    fn copies_whose_app_is_gone_or_was_translocated_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let helper = shipped(dir.path());
        let base = dir.path().join("support");
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        let orphan = |name: &str, source: Option<&str>| {
            let folder = base.join(name);
            write(&folder.join("H.app/Contents/Info.plist"), "<plist/>", 0o644);
            if let Some(source) = source {
                write(&folder.join(SOURCE_FILE), source, 0o644);
            }
            std::fs::File::open(&folder).unwrap().set_modified(old_time).unwrap();
            folder
        };
        let gone = orphan("gone", Some("/nowhere/TerminalX.app/Contents/Resources/H.app"));
        // A translocated helper that still exists this minute is gone at the
        // next launch (a new random mount), so its copy goes too.
        let mount = dir.path().join("AppTranslocation/ABC/d/H.app");
        std::fs::create_dir_all(&mount).unwrap();
        let translocated = orphan("moved", Some(&mount.to_string_lossy()));
        let unlabelled = orphan("unlabelled", None);
        let alive = orphan("alive", Some(&helper.to_string_lossy()));
        let fresh = base.join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();

        helper_to_run(&helper, &base).unwrap();
        assert!(!gone.exists() && !translocated.exists() && !unlabelled.exists());
        assert!(alive.exists(), "another build whose helper still exists keeps its copy");
        assert!(fresh.exists(), "a folder another process may be creating is left alone");
        let copy = copy_location(&base, &helper);
        assert_eq!(std::fs::read_to_string(copy.parent().unwrap().join(SOURCE_FILE)).unwrap(), helper.to_string_lossy());
    }

    #[test]
    fn each_bundled_location_has_its_own_copy() {
        let base = Path::new("/support");
        let a = copy_location(base, Path::new("/Applications/TerminalX.app/Contents/Resources/H.app"));
        let b = copy_location(base, Path::new("/repo/worktree/target/TerminalX Dev.app/Contents/Resources/H.app"));
        assert_ne!(a.parent(), b.parent());
        assert_eq!(a.file_name().unwrap(), "H.app");
    }
}
