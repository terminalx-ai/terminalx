//! Install an immutable helper outside the replaceable app bundle, then
//! discover or launch it. A window's Child handle never owns runtime lifetime.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

use super::client::Client;

fn private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let meta = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        bail!("runtime installation directory is not private");
    }
    Ok(())
}

fn digest(file: &mut File) -> Result<String> {
    let mut sha = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        sha.update(&buffer[..count]);
    }
    Ok(format!("{:x}", sha.finalize()))
}

fn open_binary(path: &Path) -> Result<File> {
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    if !file.metadata()?.is_file() { bail!("runtime executable is not a regular file"); }
    Ok(file)
}

/// Copy only the bundled helper supplied by the native launcher. Hashing the
/// whole executable makes versions coexist even when their app version matches.
pub fn install(source: &Path, home: &Path) -> Result<PathBuf> {
    use std::io::{Seek, SeekFrom};
    let mut input = open_binary(source).context("open bundled terminalx-serve")?;
    let hash = digest(&mut input)?;
    input.seek(SeekFrom::Start(0))?;
    private_dir(&home.join("runtime"))?;
    let directory = home.join("runtime").join(&hash);
    private_dir(&directory)?;
    let target = directory.join("terminalx-serve");
    if target.symlink_metadata().is_ok() {
        let mut existing = open_binary(&target)?;
        let meta = existing.metadata()?;
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 || meta.mode() & 0o100 == 0
            || digest(&mut existing)? != hash {
            bail!("installed runtime does not match its immutable version");
        }
        return Ok(target);
    }
    let mut staged = tempfile::NamedTempFile::new_in(&directory)?;
    std::io::copy(&mut input, &mut staged)?;
    staged.flush()?;
    staged.as_file_mut().seek(SeekFrom::Start(0))?;
    if digest(staged.as_file_mut())? != hash { bail!("bundled runtime changed while it was installed"); }
    staged.as_file().set_permissions(std::fs::Permissions::from_mode(0o700))?;
    staged.as_file().sync_all()?;
    match staged.persist_noclobber(&target) {
        Ok(_) => { File::open(&directory)?.sync_all()?; }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if digest(&mut open_binary(&target)?)? != hash { bail!("another install wrote an unexpected runtime"); }
        }
        Err(error) => return Err(error.error.into()),
    }
    Ok(target)
}

pub fn connect_or_start(source: &Path, home: &Path) -> Result<Arc<Client>> {
    launch(source,home,None)
}

pub fn connect_desktop(source: &Path, home: &Path, application: &str) -> Result<Arc<Client>> {
    let client = launch(source,home,Some(application))?;
    let status: serde_json::Value = client.call("status",serde_json::json!({}))?;
    if cfg!(target_os = "macos") && status["localRuntime"]["nativeTray"] != true {
        bail!("The running local owner does not support the desktop tray. Its work was left running; attach with a compatible build after it finishes.");
    }
    Ok(client)
}

fn launch(source: &Path, home: &Path, application: Option<&str>) -> Result<Arc<Client>> {
    use std::os::fd::AsRawFd;
    let home = std::fs::canonicalize(home)?;
    private_dir(&home.join("run"))?;
    // Serializes launchers, not runtimes. The runtime owns its separate lock.
    let launch = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(home.join("run/local-launch.lock"))?;
    let metadata = launch.metadata()?;
    // SAFETY: geteuid has no preconditions.
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
        bail!("local launch lock is not private");
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        // SAFETY: descriptor remains owned by `launch` until this function returns.
        if unsafe { libc::flock(launch.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { break; }
        if Instant::now() >= deadline { bail!("another desktop is starting the local runtime"); }
        std::thread::sleep(Duration::from_millis(50));
    }
    // A live but incompatible owner is an error, never permission to start a
    // competing process or terminate the running owner's work.
    if std::os::unix::net::UnixStream::connect(home.join("run/hooks.sock")).is_ok() {
        return Client::connect(&home);
    }
    let executable = install(source, &home)?;
    #[cfg(target_os = "macos")]
    {
        let verified = Command::new("/usr/bin/codesign").args(["--verify", "--strict"]).arg(&executable).output()?;
        if !verified.status.success() { bail!("the installed runtime's code signature could not be verified"); }
    }
    let mut command = Command::new(executable);
    if let Some(application) = application {
        command.env("TERMINALX_LOCAL_DESKTOP","1").env("TERMINALX_LOCAL_APPLICATION",application);
    } else {
        command.env_remove("TERMINALX_LOCAL_DESKTOP").env_remove("TERMINALX_LOCAL_APPLICATION");
    }
    command.args(["--runtime-kind", "local", "--data-dir"]).arg(&home)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and this hook only creates an OS
    // session. No allocator, lock or inherited window pipe is used after fork.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()); }
            Ok(())
        });
    }
    let mut child = command.spawn().context("start local runtime")?;
    loop {
        if let Ok(client) = Client::connect(&home) {
            std::thread::spawn(move || { let _ = child.wait(); });
            return Ok(client);
        }
        if let Some(status) = child.try_wait()? { bail!("local runtime exited before attachment: {status}"); }
        if Instant::now() >= deadline {
            // Do not kill on timeout: the runtime may already own accepted
            // work. With no attachments or work it exits by its idle policy.
            std::thread::spawn(move || { let _ = child.wait(); });
            bail!("local runtime did not become ready; it was not stopped");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_versions_survive_bundle_replacement_and_reject_tampering() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let source = fixture.path().join("bundled-helper");
        std::fs::write(&source, b"first helper image").unwrap();
        let first = install(&source, &home).unwrap();
        assert_eq!(install(&source, &home).unwrap(), first);
        std::fs::write(&source, b"updated helper image").unwrap();
        let second = install(&source, &home).unwrap();
        assert_ne!(first, second);
        std::fs::remove_file(&source).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"first helper image");
        assert_eq!(std::fs::read(&second).unwrap(), b"updated helper image");
        assert_eq!(std::fs::metadata(&first).unwrap().mode() & 0o777, 0o700);
        std::fs::write(&source, b"first helper image").unwrap();
        std::fs::write(&first, b"tampered helper").unwrap();
        assert!(install(&source, &home).is_err());
    }

    #[test]
    fn installer_refuses_symlinks_and_shared_directories() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let source = fixture.path().join("helper");
        std::fs::write(&source, b"helper image").unwrap();
        let linked = fixture.path().join("linked-helper");
        std::os::unix::fs::symlink(&source, &linked).unwrap();
        assert!(install(&linked, &home).is_err());
        let outside = fixture.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("runtime")).unwrap();
        assert!(install(&source, &home).is_err());
        std::fs::remove_file(home.join("runtime")).unwrap();
        std::fs::create_dir(home.join("runtime")).unwrap();
        std::fs::set_permissions(home.join("runtime"), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(install(&source, &home).is_err());
    }
}
