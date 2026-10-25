//! Child operations have bounded lifetimes/output and never inherit the host
//! conversation's control credentials. No shell parses host-provided arguments.
use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub fn command(program: &str) -> Result<Command> {
    let binary = super::bootstrap::installed(program)?
        .or_else(|| crate::binpath::resolve(program))
        .with_context(|| {
            format!("The {program} tool is unavailable; review the guided setup progress")
        })?;
    let mut command = Command::new(binary);
    let mut path = std::env::split_paths(&crate::binpath::login_path()).collect::<Vec<_>>();
    if program == "cua" {
        if let Some(lume) = super::bootstrap::installed("lume")? {
            path.insert(
                0,
                lume.parent()
                    .context("Prepared Lume executable has no parent")?
                    .to_owned(),
            );
            // Pinned Cua 0.7.0 otherwise downloads its built-in Lume 0.6.0.
            // Select our verified 0.6.1 executable without changing user config
            // or stopping an existing server.
            command.env("CUA_RUNTIME_LUME", "system");
        }
        command.env_remove("LUME_API");
    }
    command.env("PATH", std::env::join_paths(path)?);
    for key in [
        crate::hooks::CONTROL_TOKEN_ENV,
        crate::hooks::CONTROL_SOCKET_ENV,
        crate::hooks::TOKEN_ENV,
        crate::hooks::SOCKET_ENV,
        "CUA_DAEMON",
        "CUA_DAEMON_TOKEN",
        "CUA_ENV_TOKEN",
    ] {
        command.env_remove(key);
    }
    Ok(command)
}

pub fn run(command: &mut Command, input: &[u8], timeout: Duration) -> Result<Vec<u8>> {
    run_controlled(command, input, timeout, super::supervisor::stopping)
}

fn run_controlled(
    command: &mut Command,
    input: &[u8],
    timeout: Duration,
    canceled: impl Fn() -> bool,
) -> Result<Vec<u8>> {
    if canceled() {
        bail!("Local owner stopped; no environment operation was started");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Start local environment operation")?;
    let mut stdin = child.stdin.take().context("Child stdin unavailable")?;
    let bytes = input.to_vec();
    let (written_tx, written_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = written_tx.send(stdin.write_all(&bytes));
    });
    let mut stdout = child.stdout.take().context("Child stdout unavailable")?;
    let (read_tx, read_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> std::io::Result<Vec<u8>> {
            let mut bytes = Vec::new();
            stdout
                .by_ref()
                .take(32 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 32 * 1024 * 1024 {
                return Err(std::io::Error::other("Environment output exceeds 32 MiB"));
            }
            Ok(bytes)
        })();
        let _ = read_tx.send(result);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if canceled() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // Reading/writing pipes end when this direct child ends; descendants
            // might still own them, so do not join them on a failed operation.
            bail!("Environment operation timed out; inspect state before retrying. No host fallback occurred");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if !status.success() {
        bail!("Local environment command failed ({status}); inspect the reported setup/task stage. No host fallback occurred");
    }
    // A successful direct child can still leave inherited pipes in descendants.
    // Bound receipt collection too; pipe closure is not guest exit evidence.
    let wait = |receiver: &std::sync::mpsc::Receiver<std::io::Result<Vec<u8>>>| -> Result<Vec<u8>> {
        loop {
            if canceled() || Instant::now() >= deadline {
                bail!("Environment receipt unavailable after owner stop/timeout; external outcome is unknown");
            }
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(result) => return Ok(result?),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => return Err(error.into()),
            }
        }
    };
    loop {
        if canceled() || Instant::now() >= deadline {
            bail!("Environment input receipt unavailable; external outcome is unknown");
        }
        match written_rx.recv_timeout(Duration::from_millis(25)) {
            Ok(result) => {
                result?;
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => return Err(error.into()),
        }
    }
    wait(&read_rx)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owner_shutdown_cancels_only_the_proxy_child_and_retains_unknown_outcome() {
        let started = Instant::now();
        let result = run_controlled(
            Command::new("/bin/sleep").arg("30"),
            b"",
            Duration::from_secs(30),
            || started.elapsed() > Duration::from_millis(40),
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn external_environment_commands_remove_both_control_and_legacy_hook_credentials() {
        let command = command("sh").unwrap();
        let env: std::collections::BTreeMap<_, _> = command
            .get_envs()
            .map(|(k, v)| (k.to_owned(), v.map(|v| v.to_owned())))
            .collect();
        for key in [
            crate::hooks::CONTROL_SOCKET_ENV,
            crate::hooks::CONTROL_TOKEN_ENV,
            crate::hooks::SOCKET_ENV,
            crate::hooks::TOKEN_ENV,
        ] {
            assert_eq!(env.get(std::ffi::OsStr::new(key)), Some(&None), "{key}");
        }
    }

    #[test]
    fn real_child_roundtrip_and_timeout() {
        let bytes = run(
            &mut Command::new("/bin/cat"),
            b"selected input",
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(bytes, b"selected input");
        assert!(run(
            Command::new("/bin/sleep").arg("5"),
            b"",
            Duration::from_millis(30)
        )
        .is_err());
    }
}
