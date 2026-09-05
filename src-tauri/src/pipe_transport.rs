//! Windows transport for the same authenticated JSON-lines control/hook frames.
//! Blocking callers get a private runtime thread; app handlers never block the
//! pipe accept loop (permission hooks can wait for a human).
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

const MAX_FRAME: u64 = 20 * 1024 * 1024;

fn runtime() -> io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
}

pub fn path_for_home(home: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let home = home.canonicalize().unwrap_or_else(|_| home.to_owned());
    let digest = Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes());
    PathBuf::from(format!(r"\\.\pipe\terminalx-{:x}", digest))
}

pub fn exchange(path: &Path, bytes: Vec<u8>, timeout: Duration) -> io::Result<String> {
    let path = path.to_owned();
    std::thread::spawn(move || {
        runtime()?.block_on(async move {
            tokio::time::timeout(timeout, async {
                let mut client = loop {
                    match ClientOptions::new().open(&path) {
                        Ok(client) => break client,
                        Err(error) if error.raw_os_error() == Some(231) => {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        Err(error) => return Err(error),
                    }
                };
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
                let mut options = ServerOptions::new();
                options
                    .reject_remote_clients(true)
                    .first_pipe_instance(true);
                let mut server = match options.create(&path) {
                    Ok(server) => server,
                    Err(error) => {
                        let _ = started.send(Err(error));
                        return;
                    }
                };
                options.first_pipe_instance(false);
                let _ = started.send(Ok(()));
                loop {
                    if let Err(error) = server.connect().await {
                        log::warn!("connect control pipe: {error}");
                        break;
                    }
                    let next = match options.create(&path) {
                        Ok(next) => next,
                        Err(error) => {
                            log::warn!("listen control pipe: {error}");
                            break;
                        }
                    };
                    let connected = std::mem::replace(&mut server, next);
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
