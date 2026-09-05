//! Running one agent-browser client invocation to completion under a bound.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long to wait for output readers once the client has exited.
const READER_GRACE: Duration = Duration::from_millis(750);

use super::environment::ProcessEnvironment;

pub struct RunOptions<'a> {
    pub timeout: Duration,
    pub stdin: Option<&'a str>,
}

#[derive(Debug, Default)]
pub struct RunOutput {
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
    pub timed_out: bool,
}

/// Spawn `binary args…`, feed it `stdin`, and collect its output. On timeout
/// the child is killed and `timed_out` is set; stdout gathered so far is
/// still returned. Output is capped so a runaway page dump cannot exhaust
/// memory.
pub fn run(binary: &Path, args: &[&str], env: &ProcessEnvironment, options: RunOptions<'_>) -> std::io::Result<RunOutput> {
    const MAX_OUTPUT: usize = 64 * 1024 * 1024;
    let mut command = Command::new(binary);
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env("PATH", crate::binpath::login_path());
    for (k, v) in &env.vars {
        command.env(k, v);
    }
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(text) = options.stdin {
            // A client that exits early closes its end; that is not our error.
            let _ = stdin.write_all(text.as_bytes());
        }
        drop(stdin);
    }
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_buf = Arc::new(Mutex::new(Vec::new()));
    let err_buf = Arc::new(Mutex::new(Vec::new()));
    let out_reader = {
        let buf = out_buf.clone();
        std::thread::spawn(move || read_capped(stdout, MAX_OUTPUT, &buf))
    };
    let err_reader = {
        let buf = err_buf.clone();
        std::thread::spawn(move || read_capped(stderr, 256 * 1024, &buf))
    };
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if started.elapsed() >= options.timeout {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    // A grandchild the client left behind (or a killed shell's `sleep`) can
    // keep the pipe open; the client itself has exited, so what it wrote is
    // what there is. Give the readers a moment, then take the buffers.
    let settle = Instant::now();
    while (!out_reader.is_finished() || !err_reader.is_finished()) && settle.elapsed() < READER_GRACE {
        std::thread::sleep(Duration::from_millis(10));
    }
    let stdout = String::from_utf8_lossy(&out_buf.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    let stderr = String::from_utf8_lossy(&err_buf.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    Ok(RunOutput { stdout, stderr, status: status.and_then(|s| s.code()), timed_out })
}

fn read_capped(mut reader: impl Read, cap: usize, into: &Mutex<Vec<u8>>) {
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut buf = into.lock().unwrap_or_else(|e| e.into_inner());
                if buf.len() < cap {
                    let room = cap - buf.len();
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_env() -> ProcessEnvironment {
        ProcessEnvironment { vars: Vec::new(), socket_dir: None, owns_socket_directory: false }
    }

    #[cfg(unix)]
    #[test]
    fn collects_output_and_feeds_stdin() {
        let out = run(Path::new("/bin/sh"), &["-c", "cat; echo err >&2"], &plain_env(), RunOptions { timeout: Duration::from_secs(5), stdin: Some("hello") }).unwrap();
        assert_eq!(out.stdout, "hello");
        assert_eq!(out.stderr.trim(), "err");
        assert_eq!(out.status, Some(0));
        assert!(!out.timed_out);
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_child_that_outlives_the_bound() {
        let started = Instant::now();
        let out = run(Path::new("/bin/sh"), &["-c", "echo partial; sleep 30"], &plain_env(), RunOptions { timeout: Duration::from_millis(300), stdin: None }).unwrap();
        assert!(out.timed_out);
        assert_eq!(out.stdout.trim(), "partial");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
