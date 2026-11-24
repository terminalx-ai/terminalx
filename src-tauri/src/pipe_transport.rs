//! Windows transport for the same authenticated JSON-lines control/hook frames.
//! Blocking callers get a private runtime thread; app handlers never block the
//! pipe accept loop (permission hooks can wait for a human).
//!
//! Every pipe is this user's alone (`win::pipe::server`): an owner-only DACL,
//! no remote clients, and a client of another account is turned away. A
//! client checks the pipe is this user's own, served by one of this user's
//! processes, before it sends a frame, which carries a credential.
use crate::paths::Canonical;
use std::cell::RefCell;
use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;

const MAX_FRAME: u64 = 20 * 1024 * 1024;
const SECURITY_IDENTIFICATION: u32 = windows_sys::Win32::Storage::FileSystem::SECURITY_SQOS_PRESENT | windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;

fn runtime() -> io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
}

pub fn path_for_home(home: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let home = home.canonical().unwrap_or_else(|_| home.to_owned());
    let digest = Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes());
    PathBuf::from(format!(r"\\.\pipe\terminalx-{:x}", digest))
}

pub fn exchange(path: &Path, bytes: Vec<u8>, timeout: Duration) -> io::Result<String> {
    let path = path.to_owned();
    std::thread::spawn(move || {
        runtime()?.block_on(async move {
            tokio::time::timeout(timeout, async {
                let mut client = loop {
                    // Identification level: the server can learn who asks,
                    // and never act as this process.
                    match ClientOptions::new().security_qos_flags(SECURITY_IDENTIFICATION).open(&path) {
                        Ok(client) => break client,
                        Err(error) if error.raw_os_error() == Some(231) => {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        Err(error) => return Err(error),
                    }
                };
                crate::win::security::verify_pipe_server(&client)?;
                client.write_all(&bytes).await?;
                let mut line = String::new();
                BufReader::new(client)
                    .take(MAX_FRAME)
                    .read_line(&mut line)
                    .await?;
                if !line.ends_with('\n') {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "incomplete or oversized pipe response",
                    ));
                }
                Ok(line)
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "app reply timed out"))?
        })
    })
    .join()
    .map_err(|_| io::Error::other("pipe client thread panicked"))?
}

/// The client end of a served connection, as far as whether it is still
/// there. Holds its own handle, so a waiting decision can outlive the task
/// that read the frame.
#[derive(Clone)]
pub(crate) struct PipeClient(Arc<OwnedHandle>);

impl PipeClient {
    fn of(server: &impl AsHandle) -> io::Result<Self> {
        Ok(Self(Arc::new(server.as_handle().try_clone_to_owned()?)))
    }

    /// Whether the client is still waiting for its reply. It sends exactly
    /// one frame, so bytes after it count as gone, as on the Unix socket:
    /// unread input cannot extend a disconnected client's lifetime.
    pub(crate) fn connected(&self) -> bool {
        let mut available = 0u32;
        // SAFETY: the handle is owned by `self`. With no buffer, the call
        // only writes the count to `available`, which is live for the call.
        let peeked = unsafe {
            PeekNamedPipe(
                self.0.as_raw_handle() as _,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        peeked != 0 && available == 0
    }
}

thread_local! {
    static CLIENT: RefCell<Option<PipeClient>> = const { RefCell::new(None) };
}

/// The client of the frame being answered on this thread.
pub(crate) fn current_client() -> Option<PipeClient> {
    CLIENT.with(|client| client.borrow().clone())
}

/// Names `client` as this thread's for as long as it lives. Blocking-pool
/// threads are reused, so it is always cleared again, a panic included.
struct Answering;

impl Answering {
    fn for_client(client: Option<PipeClient>) -> Self {
        CLIENT.with(|current| *current.borrow_mut() = client);
        Self
    }
}

impl Drop for Answering {
    fn drop(&mut self) {
        CLIENT.with(|current| *current.borrow_mut() = None);
    }
}

/// Serve `path`: each connection sends one frame, which `handler` answers on
/// a blocking thread, told the frame and the process that sent it. Windows
/// records that process when the client connects (what `SO_PEERCRED` is on a
/// Unix socket), so it is whoever opened the pipe, whatever the frame says. A
/// connection whose process cannot be read is closed unanswered: its frame
/// is never handled as if nobody in particular had sent it.
pub fn serve(
    path: PathBuf,
    handler: impl Fn(String, u32) -> String + Send + Sync + 'static,
) -> io::Result<()> {
    let (started, ready) = std::sync::mpsc::sync_channel(1);
    let handler = Arc::new(handler);
    std::thread::Builder::new()
        .name("control-pipe".into())
        .spawn(move || {
            let runtime = match runtime() {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = started.send(Err(error));
                    return;
                }
            };
            runtime.block_on(async move {
                let mut server = match crate::win::pipe::server(&path, true) {
                    Ok(server) => server,
                    Err(error) => {
                        let _ = started.send(Err(error));
                        return;
                    }
                };
                let _ = started.send(Ok(()));
                loop {
                    let connected = match crate::win::pipe::accept(&mut server, &path).await {
                        Ok(connected) => connected,
                        Err(error) => {
                            log::warn!("control pipe {} stopped listening: {error}", path.display());
                            break;
                        }
                    };
                    let client = crate::win::process::pipe_client_pid(connected.as_raw_handle() as _);
                    let client = match client {
                        Ok(client) => client,
                        Err(error) => {
                            log::warn!("refused a frame on {}: its sender could not be read: {error}", path.display());
                            continue;
                        }
                    };
                    let handler = handler.clone();
                    // Without a handle of its own the client counts as there,
                    // which is what a wait falls back to with no transport.
                    let watch = PipeClient::of(&connected)
                        .inspect_err(|error| log::warn!("watch a control pipe client: {error}"))
                        .ok();
                    tokio::spawn(async move {
                        let (read, mut write) = tokio::io::split(connected);
                        let mut line = String::new();
                        let read = async {
                            BufReader::new(read)
                                .take(MAX_FRAME)
                                .read_line(&mut line)
                                .await
                        };
                        if !matches!(
                            tokio::time::timeout(Duration::from_secs(30), read).await,
                            Ok(Ok(_))
                        ) || !line.ends_with('\n')
                        {
                            return;
                        }
                        let answer = move || {
                            let _answering = Answering::for_client(watch);
                            handler(line, client)
                        };
                        let Ok(reply) = tokio::task::spawn_blocking(answer).await
                        else {
                            return;
                        };
                        let _ = tokio::time::timeout(
                            Duration::from_secs(5),
                            write.write_all(reply.as_bytes()),
                        )
                        .await;
                    });
                }
            });
        })?;
    ready
        .recv()
        .map_err(|_| io::Error::other("pipe listener failed to start"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_requests_and_timeouts() {
        let path = PathBuf::from(format!(r"\\.\pipe\terminalx-test-{}", uuid::Uuid::new_v4()));
        serve(path.clone(), |line, _client| {
            if line == "slow\n" {
                std::thread::sleep(Duration::from_millis(200));
            }
            line
        })
        .unwrap();
        let first = path.clone();
        let slow = std::thread::spawn(move || {
            exchange(&first, b"slow\n".to_vec(), Duration::from_millis(30))
                .unwrap_err()
                .kind()
        });
        assert_eq!(
            exchange(&path, b"fast\n".to_vec(), Duration::from_secs(2)).unwrap(),
            "fast\n"
        );
        assert_eq!(slow.join().unwrap(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn the_handler_is_told_which_process_sent_the_frame() {
        let path = PathBuf::from(format!(r"\\.\pipe\terminalx-test-{}", uuid::Uuid::new_v4()));
        serve(path.clone(), |_line, client| format!("{client}\n")).unwrap();
        // Whatever the frame claims, the sender is the process that opened the pipe.
        let answer = exchange(&path, b"from process 1\n".to_vec(), Duration::from_secs(2)).unwrap();
        assert_eq!(answer, format!("{}\n", std::process::id()));
    }

    #[test]
    fn a_handler_sees_its_client_leave() {
        let path = PathBuf::from(format!(r"\\.\pipe\terminalx-test-{}", uuid::Uuid::new_v4()));
        let (seen, saw) = std::sync::mpsc::channel();
        serve(path.clone(), move |line, _client| {
            let watch = current_client().expect("a served frame has a client");
            let while_waiting = watch.connected();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while watch.connected() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            seen.send((while_waiting, watch.connected())).unwrap();
            line
        })
        .unwrap();
        // The client gives up and closes its end while the handler waits.
        let error = exchange(&path, b"wait\n".to_vec(), Duration::from_millis(200)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(saw.recv_timeout(Duration::from_secs(6)).unwrap(), (true, false));
    }

    #[test]
    fn a_thread_forgets_its_client_after_answering() {
        CLIENT.with(|client| assert!(client.borrow().is_none()));
        let path = PathBuf::from(format!(r"\\.\pipe\terminalx-test-{}", uuid::Uuid::new_v4()));
        // A pipe server registers with the reactor of the runtime it is made in.
        let reactor = runtime().unwrap();
        let _entered = reactor.enter();
        let server = crate::win::pipe::server(&path, true).unwrap();
        {
            let _answering = Answering::for_client(Some(PipeClient::of(&server).unwrap()));
            assert!(current_client().is_some());
        }
        assert!(current_client().is_none());
    }
}
