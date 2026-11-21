//! The local stream transport between TerminalX processes: a Unix socket in
//! the home's private `run/` directory, or on Windows a named pipe whose name
//! is derived from the home and whose access is this user's alone.
//!
//! Callers name an endpoint with a `PathBuf` either way, so the endpoints a
//! runtime publishes in its status read the same on both.
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
pub type Stream = std::os::unix::net::UnixStream;
#[cfg(windows)]
pub type Stream = crate::win::pipe::PipeStream;
/// What a test serves an endpoint with.
#[cfg(all(test, unix))]
pub type Listener = std::os::unix::net::UnixListener;
#[cfg(all(test, windows))]
pub type Listener = crate::win::pipe::Listener;

/// Connect to the endpoint at `path`. On Windows this refuses a pipe that is
/// not owned and served by this user before anything is sent on it.
pub(crate) fn connect(path: &Path) -> io::Result<Stream> {
    Stream::connect(path)
}

/// End reads and writes on `stream` and every clone of it.
pub(crate) fn shutdown(stream: &Stream) -> io::Result<()> {
    #[cfg(unix)]
    {
        stream.shutdown(std::net::Shutdown::Both)
    }
    #[cfg(windows)]
    {
        stream.shutdown()
    }
}

/// The home's published control endpoint: whichever process holds the home
/// answers there.
pub(crate) fn published(root: &Path) -> PathBuf {
    #[cfg(unix)]
    {
        root.join("run").join("hooks.sock")
    }
    #[cfg(windows)]
    {
        crate::pipe_transport::path_for_home(root)
    }
}

/// An endpoint of this home's own, named `name`: a pipe beside the home's
/// published one (on Unix it is the file `run/<name>`).
#[cfg(windows)]
pub(crate) fn endpoint(root: &Path, name: &str) -> PathBuf {
    let name = name.strip_suffix(".sock").unwrap_or(name);
    PathBuf::from(format!("{}-{name}", published(root).display()))
}

/// Whether `candidate` is an endpoint of the home at `root`: in its `run/`
/// directory, or a pipe named for it. Anything else is refused, so a status
/// answer cannot point a client at somebody else's endpoint.
pub(crate) fn in_home(root: &Path, candidate: &Path) -> bool {
    #[cfg(unix)]
    {
        candidate.parent() == Some(root.join("run").as_path())
    }
    #[cfg(windows)]
    {
        let home = published(root).to_string_lossy().to_lowercase();
        let candidate = candidate.to_string_lossy().to_lowercase();
        candidate == home
            || candidate.strip_prefix(&home).and_then(|rest| rest.strip_prefix('-')).is_some_and(|rest| {
                !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            })
    }
}

/// An endpoint for a test to serve: a file in `dir`, or a pipe of its own.
#[cfg(test)]
pub(crate) fn test_endpoint(dir: &Path, name: &str) -> PathBuf {
    #[cfg(unix)]
    {
        dir.join(name)
    }
    #[cfg(windows)]
    {
        let _ = dir;
        PathBuf::from(format!(r"\\.\pipe\terminalx-test-{}-{name}", uuid::Uuid::new_v4().simple()))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn endpoints_belong_to_their_home_only() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let own = endpoint(home.path(), "local-42.sock");
        assert!(in_home(home.path(), &own));
        assert!(in_home(home.path(), &published(home.path())));
        assert!(!in_home(home.path(), &endpoint(other.path(), "local-42.sock")));
        assert!(!in_home(home.path(), &published(other.path())));
        let sneaky = PathBuf::from(format!("{}-..\\x", published(home.path()).display()));
        assert!(!in_home(home.path(), &sneaky));
    }
}
