//! Permission waits belong to the authenticated owner, not a window lease.
//! Provider hooks still have finite timers: Claude 2.1.309 clamps command-hook
//! milliseconds to i32::MAX; Codex 0.153.4 accepts a positive u64 in seconds.
//! Stay below the smaller ceiling, with time for the bridge to return a denial.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

static LOCAL_OWNER: AtomicBool = AtomicBool::new(false);
static WAITERS: AtomicUsize = AtomicUsize::new(0);
const MAX_WAITERS: usize = 256;
pub(crate) const PROVIDER_SECONDS: u64 = i32::MAX as u64 / 1000;
pub(crate) const WAIT: Duration = Duration::from_secs(PROVIDER_SECONDS - 30);
pub(crate) const BRIDGE_WAIT: Duration = Duration::from_secs(PROVIDER_SECONDS - 15);

/// Called only by serve after acquiring the local data-directory owner lock.
/// This is not an environment setting or a client-supplied permission grant.
pub(crate) fn enable() { LOCAL_OWNER.store(true, Ordering::Release); }

pub(crate) fn enabled() -> bool { LOCAL_OWNER.load(Ordering::Acquire) }

/// CAS keeps the original acquire/release ordering on supported Rust versions,
/// without the now-deprecated fetch_update API or an increment past the bound.
pub(super) fn increment_bounded(counter: &AtomicUsize, limit: usize) -> bool {
    let mut value = counter.load(Ordering::Acquire);
    loop {
        if value >= limit { return false; }
        match counter.compare_exchange_weak(value, value + 1, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(current) => value = current,
        }
    }
}

pub(crate) struct Permit;
impl Permit {
    pub(crate) fn acquire() -> Option<Self> {
        if increment_bounded(&WAITERS, MAX_WAITERS) { Some(Self) } else { None }
    }
}
impl Drop for Permit {
    fn drop(&mut self) { WAITERS.fetch_sub(1, Ordering::AcqRel); }
}

/// Keep no runtime/store lock while waiting. Sender removal cancels immediately;
/// losing the hook connection cancels within one tick. Owning the receiver
/// ensures a late answer fails before the caller reacquires its runtime lock.
pub(crate) fn wait<T>(rx: Receiver<T>, limit: Duration, connected: impl Fn() -> bool) -> Option<T> {
    let started = Instant::now();
    loop {
        if !connected() { return None; }
        let remaining = limit.checked_sub(started.elapsed())?;
        match rx.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(answer) => return connected().then_some(answer),
            Err(RecvTimeoutError::Disconnected) => return None,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};

    #[test]
    fn delayed_decision_and_cancellation_do_not_depend_on_a_view() {
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || wait(rx, Duration::from_secs(2), || true));
        std::thread::sleep(Duration::from_millis(150));
        tx.send(7).unwrap();
        assert_eq!(worker.join().unwrap(), Some(7));
        let (tx, rx) = mpsc::channel::<bool>();
        drop(tx);
        assert_eq!(wait(rx, Duration::from_secs(2), || true), None);
    }

    #[test]
    fn disconnect_and_deadline_drop_the_receiver_before_a_stale_answer() {
        let connected = Arc::new(AtomicBool::new(true));
        let observed = connected.clone();
        let (tx, rx) = mpsc::channel::<bool>();
        let worker = std::thread::spawn(move || wait(rx, Duration::from_secs(2), || observed.load(Ordering::Acquire)));
        connected.store(false, Ordering::Release);
        assert_eq!(worker.join().unwrap(), None);
        assert!(tx.send(true).is_err());
        let (tx, rx) = mpsc::channel::<bool>();
        assert_eq!(wait(rx, Duration::from_millis(1), || true), None);
        assert!(tx.send(true).is_err());
    }

    #[test]
    fn bounded_counter_does_not_overflow_or_exceed_limit_under_contention() {
        let counter = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(std::sync::Barrier::new(33));
        let workers: Vec<_> = (0..32).map(|_| {
            let counter = counter.clone();
            let start = start.clone();
            std::thread::spawn(move || { start.wait(); increment_bounded(&counter, 7) })
        }).collect();
        start.wait();
        let accepted = workers.into_iter().map(|worker| usize::from(worker.join().unwrap())).sum::<usize>();
        assert_eq!(accepted, 7);
        assert_eq!(counter.load(Ordering::Acquire), 7);
        let full = AtomicUsize::new(usize::MAX);
        assert!(!increment_bounded(&full, usize::MAX));
        assert_eq!(full.load(Ordering::Acquire), usize::MAX);
    }

    #[test]
    fn waiter_budget_releases_on_all_exit_paths() {
        let permits = (0..MAX_WAITERS).map(|_| Permit::acquire().unwrap()).collect::<Vec<_>>();
        assert!(Permit::acquire().is_none());
        drop(permits);
        assert!(Permit::acquire().is_some());
        assert!(WAIT < BRIDGE_WAIT);
        assert!(BRIDGE_WAIT < Duration::from_secs(PROVIDER_SECONDS));
        assert!(PROVIDER_SECONDS * 1000 <= i32::MAX as u64);
    }
}
