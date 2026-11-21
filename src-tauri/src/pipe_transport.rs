//! Windows transport for the same authenticated JSON-lines control/hook frames.
//! Blocking callers get a private runtime thread; app handlers never block the
//! pipe accept loop (permission hooks can wait for a human).
//!
//! Every pipe is this user's alone (`win::pipe::server`): an owner-only DACL,
//! no remote clients, and a client of another account is turned away. A
//! client checks the pipe is this user's own, served by one of this user's
//! processes, before it sends a frame, which carries a credential.
use crate::paths::Canonical;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;

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

pub fn serve(
    path: PathBuf,
    handler: impl Fn(String) -> String + Send + Sync + 'static,
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
                    let handler = handler.clone();
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
                        let Ok(reply) = tokio::task::spawn_blocking(move || handler(line)).await
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
        serve(path.clone(), |line| {
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
}
