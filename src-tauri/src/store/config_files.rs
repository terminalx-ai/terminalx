//! Bounded reads and atomic writes beneath an opened configuration directory.
//! Repository-controlled symlinks must never redirect a local settings write.
use std::fs::File;
#[cfg(windows)]
use std::fs::OpenOptions;
#[cfg(not(unix))]
use std::path::PathBuf;
use std::io::{Read, Write};
use std::path::Path;
use anyhow::{ensure, Context, Result};

pub(super) const MAX_BYTES: u64 = 1024 * 1024;

pub(super) struct Directory {
    #[cfg(unix)]
    file: File,
    #[cfg(not(unix))]
    path: PathBuf,
    // On Windows, deny deletion of every ancestor while the directory is held.
    #[cfg(windows)]
    _parents: Vec<File>,
}
impl Directory {
    pub(super) fn open(path: &Path, create: bool) -> Result<Option<Self>> {
        if create {
            #[cfg(unix)] {
                use std::os::fd::AsRawFd;
                use std::os::unix::ffi::OsStrExt;
                let parent = path.parent().context("Configuration directory needs a parent.")?;
                let parent = crate::workspace_file::open_relative(File::open("/")?, parent.strip_prefix("/")?)?;
                let name = std::ffi::CString::new(path.file_name().context("Configuration directory needs a name.")?.as_bytes())?;
                // SAFETY: the directory fd is held and name is a single component.
                if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() != std::io::ErrorKind::AlreadyExists { return Err(error.into()); }
                }
            }
            #[cfg(not(unix))] {
                match std::fs::create_dir(path) {
                    Ok(()) => {},
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
                    Err(e) => return Err(e.into()),
                }
            }
        }
        #[cfg(unix)]
        {
            // Walk from /, refusing symlinks in *every* component. The caller
            // supplies a canonical repository/home root, but a concurrent rename
            // must not redirect a read or write after discovery.
            let absolute = path.strip_prefix("/").context("Configuration directory must be absolute.")?;
            let opened = crate::workspace_file::open_relative(File::open("/")?, absolute);
            match opened {
                Ok(file) => { ensure!(file.metadata()?.is_dir(), "Configuration directory is not a directory."); Ok(Some(Self { file })) }
                Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(_) => anyhow::bail!("Cannot safely open configuration directory."),
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::{OpenOptionsExt, MetadataExt};
            let mut parents = Vec::new();
            for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
                let opened = OpenOptions::new().read(true).share_mode(3)
                    .custom_flags(0x02000000 | 0x00200000).open(ancestor);
                match opened {
                    Ok(file) => {
                        let meta = file.metadata()?;
                        ensure!(meta.is_dir() && meta.file_attributes() & 0x400 == 0, "Configuration directory cannot be a reparse point.");
                        parents.push(file);
                    }
                    Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(Some(Self { path: path.into(), _parents: parents }))
        }
        #[cfg(not(any(unix, windows)))]
        { anyhow::bail!("Safe configuration access is unavailable on this platform.") }
    }

    #[cfg(unix)]
    fn file(&self, name: &str, create: bool) -> Result<Option<File>> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let name = std::ffi::CString::new(name)?;
        let flags = libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
            | if create { libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL } else { libc::O_RDONLY };
        // SAFETY: directory and name live through openat; a successful descriptor is owned below.
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if fd < 0 {
            let e = std::io::Error::last_os_error();
            if !create && e.kind() == std::io::ErrorKind::NotFound { return Ok(None); }
            anyhow::bail!("Cannot safely open configuration file.");
        }
        // SAFETY: this descriptor was just opened and has no other owner.
        let file = unsafe { File::from_raw_fd(fd) };
        ensure!(file.metadata()?.is_file(), "Configuration must be a regular file.");
        Ok(Some(file))
    }

    #[cfg(windows)]
    fn file(&self, name: &str, create: bool) -> Result<Option<File>> {
        use std::os::windows::fs::{OpenOptionsExt, MetadataExt};
        let mut options = OpenOptions::new();
        options.read(!create).write(create).create_new(create).custom_flags(0x00200000);
        match options.open(self.path.join(name)) {
            Ok(file) => {
                let metadata = file.metadata()?;
                ensure!(metadata.is_file() && metadata.file_attributes() & 0x400 == 0, "Configuration must be a regular file, not a reparse point.");
                Ok(Some(file))
            }
            Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    #[cfg(not(any(unix, windows)))]
    fn file(&self, _name: &str, _create: bool) -> Result<Option<File>> {
        anyhow::bail!("Safe configuration access is unavailable on this platform.")
    }

    pub(super) fn read(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let Some(file) = self.file(name, false)? else { return Ok(None); };
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes).context("Read configuration")?;
        ensure!(bytes.len() as u64 <= MAX_BYTES, "Configuration exceeds 1 MiB.");
        Ok(Some(bytes))
    }

    #[cfg(unix)]
    pub(super) fn write(&self, name: &str, bytes: &[u8]) -> Result<()> {
        use std::os::fd::AsRawFd;
        ensure!(bytes.len() as u64 <= MAX_BYTES, "Configuration exceeds 1 MiB.");
        let temp = format!(".settings-{}.tmp", uuid::Uuid::new_v4());
        let mut file = self.file(&temp, true)?.context("Create configuration temporary file")?;
        let temp = std::ffi::CString::new(temp)?;
        let name = std::ffi::CString::new(name)?;
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            // SAFETY: both names are beneath the held directory descriptor. renameat
            // replaces a destination symlink itself, never the file it points at.
            if unsafe { libc::renameat(self.file.as_raw_fd(), temp.as_ptr(), self.file.as_raw_fd(), name.as_ptr()) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(())
        })();
        // SAFETY: best-effort removal of our unique temporary name, never a directory.
        unsafe { libc::unlinkat(self.file.as_raw_fd(), temp.as_ptr(), 0); }
        result
    }

    #[cfg(windows)]
    pub(super) fn write(&self, name: &str, bytes: &[u8]) -> Result<()> {
        ensure!(bytes.len() as u64 <= MAX_BYTES, "Configuration exceeds 1 MiB.");
        let mut temp = tempfile::NamedTempFile::new_in(&self.path)?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(self.path.join(name))?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    pub(super) fn write(&self, _name: &str, _bytes: &[u8]) -> Result<()> {
        anyhow::bail!("Safe configuration writes are unavailable on this platform.")
    }
}
