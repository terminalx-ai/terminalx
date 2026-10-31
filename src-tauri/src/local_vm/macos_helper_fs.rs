//! Descriptor-relative, bounded bootstrap storage. Never chmod existing data,
//! follow aliases, rename authorized_keys, truncate it or replace a lock inode.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Node {
    pub device: u64,
    pub inode: u64,
}
impl Node {
    pub fn of(metadata: &std::fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}
pub(super) struct Directory {
    file: File,
    path: PathBuf,
    uid: u32,
    private: bool,
}
fn name(value: &str) -> Result<CString> {
    if value.is_empty() || matches!(value, "." | "..") || value.contains('/') {
        bail!("One literal bootstrap filename required")
    }
    Ok(CString::new(value)?)
}
impl Directory {
    pub fn open(path: &Path, uid: u32, private: bool) -> Result<Self> {
        if !path.is_absolute() || path.canonicalize()? != path {
            bail!("Bootstrap paths must be unaliased")
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let result = Self {
            file,
            path: path.into(),
            uid,
            private,
        };
        result.check()?;
        Ok(result)
    }
    pub fn node(&self) -> Result<Node> {
        Ok(Node::of(&self.file.metadata()?))
    }
    pub fn uid(&self) -> Result<u32> {
        Ok(self.file.metadata()?.uid())
    }
    pub fn check(&self) -> Result<()> {
        let meta = self.file.metadata()?;
        let at = std::fs::symlink_metadata(&self.path)?;
        if !meta.is_dir()
            || !at.is_dir()
            || meta.uid() != self.uid
            || meta.mode() & if self.private { 0o077 } else { 0o022 } != 0
            || Node::of(&meta) != Node::of(&at)
            || self.path.canonicalize()? != self.path
        {
            bail!("Original bootstrap directory changed or is unsafe")
        }
        Ok(())
    }
    pub fn child(&self, value: &str, create: bool) -> Result<Self> {
        self.check()?;
        let n = name(value)?;
        if create {
            // SAFETY: valid owned directory descriptor and NUL-terminated name.
            if unsafe { libc::mkdirat(self.file.as_raw_fd(), n.as_ptr(), 0o700) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            self.file.sync_all()?;
        }
        // SAFETY: openat resolves only this fixed child beneath the owned fd.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                n.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: successful openat transferred a new owned descriptor.
        let result = Self {
            file: unsafe { File::from_raw_fd(fd) },
            path: self.path.join(value),
            uid: self.uid,
            private: true,
        };
        self.check()?;
        result.check()?;
        Ok(result)
    }
    pub fn exists(&self, value: &str) -> Result<bool> {
        self.check()?;
        name(value)?;
        match std::fs::symlink_metadata(self.path.join(value)) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
    pub fn open_file(&self, value: &str, write: bool, new: bool, private: bool) -> Result<File> {
        self.check()?;
        let n = name(value)?;
        let flags = (if write { libc::O_RDWR } else { libc::O_RDONLY })
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | libc::O_CLOEXEC
            | if new { libc::O_CREAT | libc::O_EXCL } else { 0 };
        // SAFETY: fd and fixed filename are valid; mode is used only with O_CREAT.
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), n.as_ptr(), flags, 0o600) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: this is the unique owner of the returned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        self.check_file(value, &file, private)?;
        if new {
            file.sync_all()?;
            self.file.sync_all()?;
        }
        Ok(file)
    }
    pub fn check_file(&self, value: &str, file: &File, private: bool) -> Result<()> {
        self.check()?;
        name(value)?;
        let meta = file.metadata()?;
        let at = std::fs::symlink_metadata(self.path.join(value))?;
        if !meta.is_file()
            || !at.is_file()
            || meta.uid() != self.uid
            || meta.nlink() != 1
            || meta.mode() & if private { 0o077 } else { 0o022 } != 0
            || Node::of(&meta) != Node::of(&at)
        {
            bail!("Original bootstrap file changed, has aliases or unsafe ownership/mode")
        }
        Ok(())
    }
    pub fn read(&self, value: &str, limit: u64, private: bool) -> Result<Vec<u8>> {
        let mut file = self.open_file(value, false, false, private)?;
        let bytes = read_file(&mut file, limit)?;
        self.check_file(value, &file, private)?;
        Ok(bytes)
    }
    pub fn write_new(&self, value: &str, bytes: &[u8]) -> Result<()> {
        let mut file = self.open_file(value, true, true, true)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        self.check_file(value, &file, true)?;
        self.file.sync_all()?;
        Ok(())
    }
    /// Publishing the same immutable receipt is harmless; changed/partial
    /// publications are never overwritten. This alone is not a trust proof.
    pub fn publish(&self, value: &str, bytes: &[u8]) -> Result<()> {
        if self.exists(value)? {
            if self.read(value, 512 * 1024, true)? != bytes {
                bail!("Original receipt publication changed or is incomplete")
            }
        } else {
            self.write_new(value, bytes)?;
        }
        Ok(())
    }
    pub fn lock(&self, value: &str, new: bool) -> Result<File> {
        let file = self.open_file(value, true, new, true)?;
        lock_file(&file)?;
        Ok(file)
    }
}
pub(super) fn lock_file(file: &File) -> Result<()> {
    // SAFETY: descriptor remains owned for the guard lifetime; never unlink it.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("Original bootstrap actor/file is still owned")
    }
    Ok(())
}
pub(super) fn read_file(file: &mut File, limit: u64) -> Result<Vec<u8>> {
    if file.metadata()?.len() > limit {
        bail!("Bootstrap file exceeds bound")
    }
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!("Bootstrap file exceeds bound")
    }
    Ok(bytes)
}
pub(super) fn json<T: serde::de::DeserializeOwned>(
    dir: &Directory,
    value: &str,
    limit: u64,
) -> Result<T> {
    serde_json::from_slice(&dir.read(value, limit, true)?)
        .context("Invalid bounded bootstrap record")
}
