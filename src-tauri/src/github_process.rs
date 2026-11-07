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

pub(crate) fn output_admitted(mut command: Command, timeout: Duration, input: Option<Vec<u8>>, ticket: Ticket) -> Result<Output> {
    let _privacy = ticket.enter()?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = read_all(child.stdout.take().expect("piped stdout"));
    let stderr = read_all(child.stderr.take().expect("piped stderr"));
    // A provider that stops reading its request body must not prevent privacy
    // activation. Poll cancellation independently of every pipe operation.
    let stdin = input.map(|bytes| {
        let mut pipe = child.stdin.take().expect("piped stdin");
        std::thread::spawn(move || pipe.write_all(&bytes))
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if !ticket.valid() { break Err(anyhow::anyhow!(crate::data_privacy::MESSAGE)); }
        if Instant::now() >= deadline { break Err(anyhow::anyhow!("GitHub did not answer within {} seconds.", timeout.as_secs())); }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => break Err(error.into()),
        }
    };
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
    match (stdout, stderr) {
        (Ok(stdout), Ok(stderr)) => Ok(Output { status, stdout: stdout?, stderr: stderr? }),
        _ => bail!("GitHub output reader failed"),
    }
}

#[cfg(all(test, unix))]
#[path = "github_process_privacy_tests.rs"]
mod tests;
