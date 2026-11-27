//! Binary ProxyCommand connected to the app over a private Unix socket.
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixListener;
use std::time::{Duration, Instant};

use serde_json::json;

pub(crate) fn run(
    org: &str,
    workspace: &str,
    scope: &str,
    output: &mut dyn Write,
) -> Result<(), String> {
    let local_error = |_| "SSH proxy socket failed".to_string();
    let directory = tempfile::Builder::new()
        .prefix("terminalx-ssh-")
        .tempdir_in("/tmp")
        .map_err(local_error)?;
    let socket = directory.path().join("stream");
    let listener = UnixListener::bind(&socket).map_err(local_error)?;
    listener.set_nonblocking(true).map_err(local_error)?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let result = crate::control::call(
        "cloud.ssh-stream",
        json!({ "orgId": org, "workspaceId": workspace, "scope": scope, "socket": socket, "nonce": nonce }),
        Duration::from_secs(45),
    ).map_err(|error| error.message)?;
    if !result.ok {
        return Err(result
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "SSH connection refused".into()));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(local_error(error)),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(local_error)?;
    let mut proof = [0u8; 32];
    stream.read_exact(&mut proof).map_err(local_error)?;
    if proof != nonce.as_bytes() {
        return Err("SSH proxy channel changed".into());
    }
    stream.set_read_timeout(None).map_err(local_error)?;
    let mut upload = stream.try_clone().map_err(local_error)?;
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut upload);
        let _ = upload.shutdown(Shutdown::Write);
    });
    let answer = std::io::copy(&mut stream, output)
        .and_then(|_| output.flush())
        .map_err(local_error);
    let _ = stream.shutdown(Shutdown::Both);
    answer
}
