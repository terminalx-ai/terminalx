//! Child operations have bounded lifetimes/output and never inherit the host
//! conversation's control credentials. No shell parses host-provided arguments.
use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub fn command(program: &str) -> Result<Command> {
    let binary = crate::binpath::resolve(program)
        .with_context(|| format!("Install {program} separately, then run compatibility checks"))?;
    let mut command = Command::new(binary);
    command.env("PATH", crate::binpath::login_path());
    for key in [
        "TERMINALX_NEXT_TOKEN",
        "TERMINALX_NEXT_SOCKET",
        "CUA_DAEMON",
        "CUA_DAEMON_TOKEN",
        "CUA_ENV_TOKEN",
    ] {
        command.env_remove(key);
    }
    Ok(command)
}

pub fn run(command: &mut Command, input: &[u8], timeout: Duration) -> Result<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Start local environment operation")?;
    let mut stdin = child.stdin.take().context("Child stdin unavailable")?;
    let bytes = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&bytes));
    let mut stdout = child.stdout.take().context("Child stdout unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .by_ref()
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(std::io::Error::other("Environment output exceeds 32 MiB"));
        }
        Ok(bytes)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // Reading/writing pipes end when this direct child ends; descendants
            // might still own them, so do not join them on a failed operation.
            bail!("Environment operation timed out; inspect state before retrying. No host fallback occurred");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if !status.success() {
        bail!("Environment operation failed ({status}); check the VM state, guest login, permissions, disk and networking. No host fallback occurred");
    }
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("Environment writer stopped"))??;
    reader
        .join()
        .map_err(|_| anyhow::anyhow!("Environment reader stopped"))?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
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
