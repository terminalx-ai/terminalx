//! Admission for GitHub processes owned by the app, never agent subprocesses.
//!
//! Capture before queuing a logical request and retain it across its pages,
//! fallbacks and writes. A scope carries authority without holding activation
//! open; only a live subprocess owns a lease, until it and its I/O are drained.

use std::cell::RefCell;
use std::io::{Read, Write};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use crate::data_privacy::Ticket;

pub(crate) const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub(crate) struct TimedOut(Duration);
impl std::fmt::Display for TimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GitHub did not answer within {} seconds.", self.0.as_secs())
    }
}
impl std::error::Error for TimedOut {}

#[derive(Debug)]
pub(crate) struct Stopped;
impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Git transfer was cancelled") }
}
impl std::error::Error for Stopped {}

thread_local! {
    static CURRENT: RefCell<Option<Ticket>> = const { RefCell::new(None) };
}

pub(crate) fn ticket() -> Ticket {
    CURRENT.with(|current| current.borrow().clone())
        .or_else(crate::data_privacy::remote_ticket).unwrap_or_default()
}

pub(crate) struct Scope {
    previous: Option<Ticket>,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl Drop for Scope {
    fn drop(&mut self) { CURRENT.with(|current| current.replace(self.previous.take())); }
}

pub(crate) fn scope() -> Scope { enter_scope(ticket()) }

pub(crate) fn with_ticket<R>(ticket: Ticket, work: impl FnOnce() -> R) -> R {
    let _scope = enter_scope(ticket);
    work()
}

fn enter_scope(ticket: Ticket) -> Scope {
    Scope { previous: CURRENT.with(|current| current.replace(Some(ticket))), _thread: Default::default() }
}

/// Capture now, not when the blocking worker eventually starts. Carrying an
/// expired ticket still permits local metadata, but cannot spawn network work.
pub(crate) fn queued<F, R>(work: F) -> impl FnOnce() -> R + Send
where F: FnOnce() -> R + Send {
    let ticket = ticket();
    move || {
        let _scope = enter_scope(ticket);
        work()
    }
}

fn read_all(pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<std::io::Result<Vec<u8>>> {
    std::thread::spawn(move || {
        let mut pipe = pipe;
        let mut bytes = Vec::new();
        pipe.read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}

pub(crate) fn output(command: Command, timeout: Duration, input: Option<Vec<u8>>) -> Result<Output> {
    output_admitted(command, timeout, input, ticket())
}

pub(crate) fn output_admitted(command: Command, timeout: Duration, input: Option<Vec<u8>>, ticket: Ticket) -> Result<Output> {
    output_process(command, timeout, input, ticket, Execution { git: false, stop: &|| false, progress: None })
}

/// Only explicitly requested Git transfers may acquire promised objects. The
/// inspection builder's override is removed inside this admitted execution
/// path, never by handing an unrestricted Command back to a caller. Preserve
/// an intentional inherited Git preference, if the person supplied one.
pub(crate) fn git_output_admitted(command: Command, timeout: Duration, ticket: Ticket) -> Result<Output> {
    git_output_reporting(command, timeout, ticket, &|| false, None)
}

type Progress = Box<dyn Fn(&str) + Send>;

pub(crate) fn git_output_reporting(mut command: Command, timeout: Duration, ticket: Ticket, stop: &dyn Fn() -> bool, progress: Option<Progress>) -> Result<Output> {
    if let Some(value) = std::env::var_os("GIT_NO_LAZY_FETCH") { command.env("GIT_NO_LAZY_FETCH", value); }
    else { command.env_remove("GIT_NO_LAZY_FETCH"); }
    output_process(command, timeout, None, ticket, Execution { git: true, stop, progress })
}

fn read_progress(pipe: impl Read + Send + 'static, progress: Progress) -> std::thread::JoinHandle<std::io::Result<Vec<u8>>> {
    std::thread::spawn(move || {
        let mut pipe = pipe;
        let mut result = Vec::new();
        let mut pending = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut emit = |pending: &mut Vec<u8>, redrawn: bool| {
            let text = String::from_utf8_lossy(pending);
            let line = text.trim();
            if !line.is_empty() {
                progress(line);
                if !redrawn { result.extend_from_slice(line.as_bytes()); result.push(b'\n'); }
            }
            pending.clear();
        };
        loop {
            let count = match pipe.read(&mut chunk) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if count == 0 { break; }
            for &byte in &chunk[..count] {
                if byte == b'\r' || byte == b'\n' { emit(&mut pending, byte == b'\r'); }
                else { pending.push(byte); }
            }
        }
        emit(&mut pending, false);
        Ok(result)
    })
}

struct Execution<'a> { git: bool, stop: &'a dyn Fn() -> bool, progress: Option<Progress> }

fn output_process(mut command: Command, timeout: Duration, input: Option<Vec<u8>>, ticket: Ticket, execution: Execution<'_>) -> Result<Output> {
    let Execution { git, stop, progress } = execution;
    let _privacy = ticket.enter()?;
    if stop() { return Err(Stopped.into()); }
    let _transport = if git { Some(crate::git::ssh::prepare(&mut command)?) } else { None };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = read_all(child.stdout.take().expect("piped stdout"));
    let pipe = child.stderr.take().expect("piped stderr");
    let stderr = match progress { Some(progress) => read_progress(pipe, progress), None => read_all(pipe) };
    // A provider that stops reading its request body must not prevent privacy
    // activation. Poll cancellation independently of every pipe operation.
    let stdin = input.map(|bytes| {
        let mut pipe = child.stdin.take().expect("piped stdin");
        std::thread::spawn(move || pipe.write_all(&bytes))
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if !ticket.valid() { break Err(anyhow::anyhow!(crate::data_privacy::MESSAGE)); }
        if stop() { break Err(Stopped.into()); }
        if Instant::now() >= deadline { break Err(TimedOut(timeout).into()); }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => break Err(error.into()),
        }
    };
    #[cfg(unix)]
    if git && status.is_err() {
        // Git owns its index/ref lockfiles and cleans them on SIGTERM. Give
        // every member of this exact group a bounded cleanup opportunity;
        // never delete a repository lock ourselves. Admission stays held.
        unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
        std::thread::sleep(Duration::from_millis(250));
    }
    // All exits, including wait errors and successful parents with surviving
    // descendants, follow the same cleanup. Never release admission first.
    #[cfg(unix)]
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
    let written = stdin.map(|writer| writer.join());
    let stdout = stdout.join();
    let stderr = stderr.join();
    anyhow::ensure!(ticket.valid(), crate::data_privacy::MESSAGE);
    let status = status?;
    if let Some(written) = written {
        written.map_err(|_| anyhow::anyhow!("GitHub input writer failed"))??;
    }
    let output = match (stdout, stderr) {
        (Ok(stdout), Ok(stderr)) => Ok(Output { status, stdout: stdout?, stderr: stderr? }),
        _ => bail!("GitHub output reader failed"),
    };
    // A completed process no longer holds activation open between the reads of
    // a logical operation. Its caller must keep the original request ticket.
    drop(_privacy);
    #[cfg(test)]
    {
        let hook = AFTER_OUTPUT.lock().unwrap().take();
        if let Some(hook) = hook { hook(); }
    }
    output
}

// Deterministically pause between physical calls, after all I/O and admission
// are released, without mocking the real process/operation under test.
#[cfg(test)]
pub(crate) static AFTER_OUTPUT: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

#[cfg(all(test, unix))]
#[path = "github_process_privacy_tests.rs"]
mod tests;
