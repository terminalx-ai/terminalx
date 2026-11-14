//! Cross-language fixture for integrations/lume-bootstrap/Tests/enrollment_test.py
//! and protocol_test.py: runs the guest side on an inherited socket descriptor
//! against the Swift owner. The seed is read from a 0600 file, never argv;
//! output carries digests and states only. Test use only; never shipped.
//!
//! `retire <root>` runs the production `helper::run` once over that descriptor,
//! with a disposable guest root seeded and owned by the caller instead of `/`
//! and root. Its installer reports an install it never performs, so the real
//! owner reaches the host-key report, the acknowledgement and retirement
//! unprivileged; the forking installer's own tests cover installs.
#[cfg(target_os = "macos")]
fn main() {
    use serde_json::json;
    use std::os::{fd::FromRawFd, unix::fs::PermissionsExt, unix::net::UnixStream};
    use std::time::Duration;
    use terminalx_vm_bootstrap::{account, child, enroll, helper, keys, wire};

    struct Inherited(Option<UnixStream>);
    impl helper::Guest for Inherited {
        type Stream = UnixStream;
        fn connect(&mut self, _: Duration) -> Result<UnixStream, wire::Failure> {
            self.0.take().ok_or(wire::Failure {
                stage: "connect",
                errno: libc::ECONNREFUSED,
            })
        }
        fn sleep(&mut self, duration: Duration) {
            std::thread::sleep(duration)
        }
        fn accounts(&mut self) -> Vec<serde_json::Value> {
            account::observe()
        }
    }
    struct ReportsInstalled;
    impl child::Installer for ReportsInstalled {
        fn install(&mut self, _: &account::ConfirmedAccount, _: &keys::KeyGrant) -> String {
            "publicKeyInstalled".into()
        }
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    let (fd, seed_path, mode, root) = match args.as_slice() {
        [fd, seed] => (fd, seed, "echo", None),
        [fd, seed, mode] if mode == "enroll-only" || mode == "confirm" => {
            (fd, seed, mode.as_str(), None)
        }
        [fd, seed, mode, root] if mode == "retire" => (fd, seed, "retire", Some(root)),
        _ => {
            eprintln!("usage: enroll-fixture <fd> <seed-file> [enroll-only|confirm|retire <root>]");
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
        if let Some(root) = root {
            let layout = helper::Layout { root: root.into() };
            let schedule = helper::Schedule {
                interval: Duration::from_millis(100),
                connects: 1,
                connect_timeout: Duration::from_secs(1),
                exchange: Duration::from_secs(3),
                person: Duration::from_secs(30),
                attempts: 1,
            };
            // SAFETY: no preconditions.
            let owner = unsafe { libc::geteuid() };
            let outcome = helper::run(
                &layout,
                owner,
                &schedule,
                &mut Inherited(Some(stream)),
                &mut ReportsInstalled,
            );
            return match outcome {
                helper::Outcome::Finished(result) => Ok(result),
                other => Err(std::io::Error::other(format!("{other:?}"))),
            };
        }
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
            let accounts = account::observe();
            let state =
                std::env::temp_dir().join(format!("tx-helper-state-{}", std::process::id()));
            let mut installer = child::Forking { state };
            let mut reached = helper::converse(
                &mut session,
                &mut stream,
                &challenge,
                &seed.bootstrap_id,
                &accounts,
                &mut installer,
                std::path::Path::new("/etc/ssh"),
                0,
                Duration::from_secs(30),
            )?
            .summary;
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
