//! Cross-language fixture for integrations/lume-bootstrap/Tests/enrollment_test.py:
//! runs the guest enrollment on an inherited socket descriptor against the Swift
//! owner. The seed is read from a 0600 file, never argv; output carries digests
//! and states only. Test use only; never shipped.
#[cfg(target_os = "macos")]
fn main() {
    use serde_json::json;
    use std::os::{fd::FromRawFd, unix::fs::PermissionsExt, unix::net::UnixStream};
    use std::time::Duration;
    use terminalx_vm_bootstrap::enroll;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let (fd, seed_path, mode) = match args.as_slice() {
        [fd, seed] => (fd, seed, "echo"),
        [fd, seed, mode] if mode == "enroll-only" || mode == "confirm" => (fd, seed, mode.as_str()),
        _ => {
            eprintln!("usage: enroll-fixture <fd> <seed-file> [enroll-only|confirm]");
            std::process::exit(64);
        }
    };
    let result = (|| -> std::io::Result<serde_json::Value> {
        let fd: i32 = fd
            .parse()
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        if std::fs::metadata(seed_path)?.permissions().mode() & 0o777 != 0o600 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "seed file must be 0600",
            ));
        }
        let seed = enroll::Seed::parse(&std::fs::read(seed_path)?)?;
        // SAFETY: the test passes this descriptor to this process alone.
        let mut stream = unsafe { UnixStream::from_raw_fd(fd) };
        // SAFETY: no preconditions.
        let claims = json!({"euid": unsafe { libc::geteuid() }, "fixture": true});
        let (mut session, challenge) =
            enroll::enroll(&mut stream, &seed, &claims, Duration::from_secs(3))?;
        if mode == "enroll-only" {
            return Ok(json!({"authenticated": true, "challengeSha256": challenge}));
        }
        if mode == "confirm" {
            // The production helper's conversation after acceptance. Accounts
            // are a read-only observation of this host's personal accounts, and
            // the real forking installer, unprivileged, refuses before any fork
            // or write; that refusal is what gets reported. The host key would
            // be read only from root-owned /etc/ssh, never generated or changed.
            let accounts = terminalx_vm_bootstrap::account::observe();
            let state =
                std::env::temp_dir().join(format!("tx-helper-state-{}", std::process::id()));
            let mut installer = terminalx_vm_bootstrap::child::Forking { state };
            let mut reached = terminalx_vm_bootstrap::helper::converse(
                &mut session,
                &mut stream,
                &seed.bootstrap_id,
                &accounts,
                &mut installer,
                std::path::Path::new("/etc/ssh"),
                0,
                Duration::from_secs(30),
            )?;
            reached["authenticated"] = json!(true);
            reached["challengeSha256"] = json!(challenge);
            return Ok(reached);
        }
        session.send(&mut stream, json!({"hello": "rust helper"}))?;
        let echo = session.receive(&mut stream)?;
        Ok(json!({"authenticated": true, "challengeSha256": challenge, "echo": echo}))
    })();
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!(
                "{}",
                json!({"authenticated": false, "error": error.to_string()})
            );
            std::process::exit(3);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {}
