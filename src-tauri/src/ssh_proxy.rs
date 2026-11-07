//! Binary-clean ProxyCommand. The app authenticates and opens the existing
//! E2EE port stream; this client only copies SSH bytes over local loopback.
use serde_json::json;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

pub fn run(org: &str, workspace: &str, scope: &str, output: &mut dyn Write) -> Result<(), String> {
    let result = crate::control::call(
        "cloud.ssh-open",
        json!({ "orgId": org, "workspaceId": workspace, "scope": scope }),
        Duration::from_secs(50),
    )
    .map_err(|e| e.message)?;
    if !result.ok {
        return Err(result
            .error
            .map(|e| e.message)
            .unwrap_or_else(|| "SSH connection refused".into()));
    }
    let result = result.result.ok_or("SSH connection unavailable")?;
    let port = result["localPort"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0)
        .ok_or("Invalid SSH proxy port")?;
    let lease = result["leaseId"]
        .as_str()
        .ok_or("Invalid SSH proxy lease")?
        .to_string();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let keep = lease.clone();
    let socket =
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)).map_err(|_| "SSH proxy disconnected")?;
    let control_socket = socket.try_clone().map_err(|_| "SSH proxy disconnected")?;
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(20));
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let kept = crate::control::call(
                "cloud.ssh-keep",
                json!({"leaseId":keep}),
                Duration::from_secs(10),
            );
            if !matches!(kept, Ok(response) if response.ok) {
                let _ = control_socket.shutdown(Shutdown::Both);
                break;
            }
        }
    });
    let outcome =
        bridge(std::io::stdin(), output, socket).map_err(|_| "SSH proxy disconnected".to_string());
    stopped.store(true, Ordering::SeqCst);
    let _ = crate::control::call(
        "cloud.ssh-close",
        json!({"leaseId":lease}),
        Duration::from_secs(10),
    );
    outcome
}

fn bridge(
    input: impl Read + Send + 'static,
    output: &mut dyn Write,
    mut socket: TcpStream,
) -> std::io::Result<()> {
    let mut writer = socket.try_clone()?;
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut { input }, &mut writer);
        let _ = writer.shutdown(Shutdown::Write);
    });
    let result = std::io::copy(&mut socket, output).and_then(|_| output.flush());
    let _ = socket.shutdown(Shutdown::Both);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proxy_copies_binary_data_and_half_closes_without_json_or_logs() {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        assert!(listener.local_addr().unwrap().ip().is_loopback());
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut input = Vec::new();
            s.read_to_end(&mut input).unwrap();
            assert_eq!(input, b"SSH-2.0-test\r\n\0\xff");
            s.write_all(b"SSH-2.0-server\r\n\xff\0").unwrap();
        });
        let socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut output = Vec::new();
        bridge(
            std::io::Cursor::new(b"SSH-2.0-test\r\n\0\xff".to_vec()),
            &mut output,
            socket,
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(output, b"SSH-2.0-server\r\n\xff\0");
    }
}
