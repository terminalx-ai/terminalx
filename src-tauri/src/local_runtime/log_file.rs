//! The runtime's own log, in a file it rotates. A desktop starts the runtime
//! detached, with nobody reading its output, so without this every line it
//! logs is lost, and with them the account of a runtime that wedged (#661).
//!
//! The desktop keeps one too, beside it ([`Tee`]): opened from the Dock its
//! stderr goes nowhere, and with it every line about a lost connection (#716).

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// A log this long is moved aside and started afresh. One older file is kept.
pub const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Open the log for appending, private to this user.
pub fn open(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)
}

/// The file the previous log is kept in: `runtime.log.1` beside `runtime.log`.
pub fn previous(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

/// The log as the runtime writes it. Its records go through this, and its
/// stdout and stderr point at the same file, so whatever else it prints (a
/// panic above all) lands in the current file too.
pub struct Log {
    path: PathBuf,
    file: File,
    written: u64,
    /// Whether stdout and stderr follow the log to each new file.
    redirect: bool,
}

impl Log {
    pub fn install(path: &Path) -> io::Result<Self> {
        Self::open(path, true)
    }

    /// The log, without taking over this process's stdout and stderr.
    pub fn append(path: &Path) -> io::Result<Self> {
        Self::open(path, false)
    }

    fn open(path: &Path, redirect_output: bool) -> io::Result<Self> {
        let full = std::fs::metadata(path).is_ok_and(|metadata| metadata.len() >= MAX_BYTES);
        let file = if full { start_afresh(path)? } else { open(path)? };
        let written = file.metadata()?.len();
        if redirect_output { redirect(&file)?; }
        Ok(Self { path: path.to_path_buf(), file, written, redirect: redirect_output })
    }

    fn rotate(&mut self) -> io::Result<()> {
        let file = start_afresh(&self.path)?;
        if self.redirect { redirect(&file)?; }
        self.file = file;
        self.written = 0;
        Ok(())
    }
}

/// Move the log aside, over the older one, and open a fresh one in its place.
fn start_afresh(path: &Path) -> io::Result<File> {
    std::fs::rename(path, previous(path))?;
    open(path)
}

/// Point stdout and stderr at `file`.
fn redirect(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    for target in [libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        // SAFETY: dup2 onto the standard descriptors; `file` stays open for the call.
        if unsafe { libc::dup2(file.as_raw_fd(), target) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

impl Write for Log {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // A log that cannot be moved aside goes on growing rather than going quiet.
        if self.written >= MAX_BYTES && self.rotate().is_err() {
            self.written = 0;
        }
        let count = self.file.write(bytes)?;
        self.written += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// A process's log as it goes to stderr and, once [`keep`] has named one, a
/// file: the desktop's, which knows where its logs belong only once the app
/// is set up, after its first lines.
pub struct Tee(&'static OnceLock<Mutex<Log>>);

impl Tee {
    pub fn new(file: &'static OnceLock<Mutex<Log>>) -> Self { Self(file) }
}

/// Keep `file`'s log at `path` from now on.
pub fn keep(file: &OnceLock<Mutex<Log>>, path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    file.set(Mutex::new(Log::append(path)?)).map_err(|_| io::Error::other("this log is already kept in a file"))
}

impl Write for Tee {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // Neither may cost the other a line: a closed stderr is normal for an
        // app opened from the Dock, and a full disk must not silence stderr.
        let _ = io::stderr().write_all(bytes);
        if let Some(file) = self.0.get() {
            let _ = file.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).write_all(bytes);
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = io::stderr().flush();
        if let Some(file) = self.0.get() { let _ = file.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).flush(); }
        Ok(())
    }
}

/// How a log line says how long something took: "850 ms", "4.2 s",
/// "3 min 5 s", "2 h 13 min".
pub fn span(duration: Duration) -> String {
    let seconds = duration.as_secs();
    match seconds {
        0 => format!("{} ms", duration.as_millis()),
        1..=59 => format!("{:.1} s", duration.as_secs_f64()),
        60..=3599 => format!("{} min {} s", seconds / 60, seconds % 60),
        _ => format!("{} h {} min", seconds / 3600, seconds % 3600 / 60),
    }
}

/// How a log line says how many bytes: "512 B", "683.0 KiB", "2.0 MiB".
pub fn size(bytes: usize) -> String {
    const KIB: f64 = 1024.0;
    match bytes {
        0..=1023 => format!("{bytes} B"),
        1024..=1_048_575 => format!("{:.1} KiB", bytes as f64 / KIB),
        _ => format!("{:.1} MiB", bytes as f64 / KIB / KIB),
    }
}

// Never `install` here: it points this test process's own output at the file.
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_tee_writes_each_line_to_its_file_once_one_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs/desktop.log");
        let file: &'static OnceLock<Mutex<Log>> = Box::leak(Box::new(OnceLock::new()));
        let mut tee = Tee::new(file);
        tee.write_all(b"before\n").unwrap();
        keep(file, &path).unwrap();
        tee.write_all(b"after\n").unwrap();
        tee.flush().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"after\n", "a line from before setup was only on stderr");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(keep(file, &path).is_err(), "kept once");
    }

    #[test]
    fn spans_and_sizes_read_as_a_person_would_say_them() {
        assert_eq!(span(Duration::from_millis(850)), "850 ms");
        assert_eq!(span(Duration::from_millis(4_240)), "4.2 s");
        assert_eq!(span(Duration::from_secs(185)), "3 min 5 s");
        assert_eq!(span(Duration::from_secs(2 * 3600 + 13 * 60 + 9)), "2 h 13 min");
        assert_eq!(size(512), "512 B");
        assert_eq!(size(699_136), "682.8 KiB");
        assert_eq!(size(2 * 1024 * 1024), "2.0 MiB");
    }

    #[test]
    fn a_full_log_is_moved_aside_with_one_older_file_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.log");
        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize]).unwrap();
        std::fs::write(previous(&path), b"oldest").unwrap();
        let mut fresh = start_afresh(&path).unwrap();
        fresh.write_all(b"next\n").unwrap();
        assert_eq!(previous(&path), dir.path().join("runtime.log.1"));
        assert_eq!(std::fs::metadata(previous(&path)).unwrap().len(), MAX_BYTES);
        assert_eq!(std::fs::read(&path).unwrap(), b"next\n");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn records_past_the_limit_go_to_a_fresh_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.log");
        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize - 4]).unwrap();
        let mut log = Log::open(&path, false).unwrap();
        log.write_all(b"last\n").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), MAX_BYTES + 1, "a record is never split across files");
        log.write_all(b"first\n").unwrap();
        log.write_all(b"second\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first\nsecond\n");
        assert!(std::fs::read(previous(&path)).unwrap().ends_with(b"last\n"));
    }

    #[test]
    fn a_log_already_full_when_the_runtime_starts_is_moved_aside_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.log");
        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize]).unwrap();
        let mut log = Log::open(&path, false).unwrap();
        log.write_all(b"started\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"started\n");
        assert_eq!(std::fs::metadata(previous(&path)).unwrap().len(), MAX_BYTES);
    }

    #[test]
    fn the_log_is_never_opened_through_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::write(&elsewhere, b"").unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.path().join("runtime.log")).unwrap();
        assert!(open(&dir.path().join("runtime.log")).is_err());
    }
}
