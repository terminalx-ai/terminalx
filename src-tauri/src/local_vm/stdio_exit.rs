//! An attached desktop adapter's ordinary end (review 2).
//!
//! A tab stop, restart or quit sends SIGTERM (or SIGHUP) to the agent's whole
//! process group, adapters included. Left to its default, the signal killed an
//! adapter before it released its desktop lease, so the next launch found the
//! desktop reserved. Here the signals are taken by one thread, which reports
//! them, so the adapter ends as it does when its agent closes stdin.
use anyhow::{Context, Result};
use std::sync::mpsc::{self, Receiver};

const SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGHUP, libc::SIGINT];

fn set() -> libc::sigset_t {
    // SAFETY: sigemptyset/sigaddset initialize and fill a local set.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in SIGNALS {
            libc::sigaddset(&mut set, signal);
        }
        set
    }
}

/// The termination signals that arrived, from the thread that takes them.
pub(crate) struct Signals {
    received: Receiver<libc::c_int>,
    #[cfg_attr(not(test), allow(dead_code))]
    watcher: std::thread::JoinHandle<()>,
}

impl Signals {
    pub(crate) fn try_recv(&self) -> bool { self.received.try_recv().is_ok() }
    pub(crate) fn recv(&self) -> Option<libc::c_int> { self.received.recv().ok() }
    /// The thread that takes the signals, for a test to signal directly.
    #[cfg(test)]
    pub(crate) fn watcher(&self) -> &std::thread::JoinHandle<()> { &self.watcher }
}

/// Blocks the termination signals in this thread and every thread it starts
/// from now on, and reports each one that arrives. Call it on the main thread
/// before starting any other, so that no thread is left for a signal to kill.
pub(crate) fn watch() -> Result<Signals> {
    let set = set();
    // SAFETY: the set is initialized; the old mask is not needed.
    let code = unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) };
    if code != 0 {
        return Err(std::io::Error::from_raw_os_error(code)).context("block termination signals");
    }
    let (send, received) = mpsc::channel();
    let watcher = std::thread::Builder::new().name("adapter-signals".into()).spawn(move || loop {
        let mut signal = 0;
        // SAFETY: the set is initialized and every signal in it is blocked.
        if unsafe { libc::sigwait(&set, &mut signal) } == 0 && send.send(signal).is_err() {
            return;
        }
    })?;
    Ok(Signals { received, watcher })
}

/// For a child started after `watch`: it inherits the blocked mask, so its
/// own default handling is restored before it runs.
pub(crate) fn unblock_in_child(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: pthread_sigmask is async-signal-safe and touches only the child.
    unsafe {
        command.pre_exec(|| {
            let set = set();
            match libc::pthread_sigmask(libc::SIG_UNBLOCK, &set, std::ptr::null_mut()) {
                0 => Ok(()),
                code => Err(std::io::Error::from_raw_os_error(code)),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::os::unix::thread::JoinHandleExt;

    #[test]
    fn a_termination_signal_is_reported_and_a_child_keeps_its_default() {
        let signals = watch().unwrap();
        for signal in SIGNALS {
            // A process-directed signal finds the watcher, the one thread not
            // blocking it, once the main thread blocked it first; here it is
            // sent to the watcher itself, as libtest's own threads do not block it.
            // SAFETY: the watcher thread is alive and blocks this signal.
            assert_eq!(unsafe { libc::pthread_kill(signals.watcher.as_pthread_t(), signal) }, 0);
            assert_eq!(signals.received.recv_timeout(std::time::Duration::from_secs(5)).unwrap(), signal);
        }
        assert!(!signals.try_recv());
        let mut child = std::process::Command::new("/bin/sh");
        child.args(["-c", "kill -TERM $$; sleep 5"]);
        unblock_in_child(&mut child);
        assert_eq!(child.status().unwrap().signal(), Some(libc::SIGTERM), "a child keeps the default action");
    }
}
