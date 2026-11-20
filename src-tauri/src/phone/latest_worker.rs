//! One background thread per owner that runs only the latest job asked of it
//! (#1338). Each `sync.prefetch` used to start a thread of its own; one that
//! a newer request replaced kept reading and hashing whole logs until its next
//! check, so a phone that turned the setting on and off, or came back to the
//! foreground a few times, had as many of them at work at once.
//!
//! A job asked for while one runs waits in a single slot, replacing any that
//! waited there before, and the one running is told it is no longer wanted. So
//! at most one thread runs, a request in between is never run at all, and the
//! last one asked for always is.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;

/// Does one job, checking the function it is given that the job is still wanted.
type Run<J> = Box<dyn Fn(J, &dyn Fn() -> bool) + Send + Sync>;

pub(super) struct LatestWorker<J> {
    inner: Arc<Inner<J>>,
}

struct Inner<J> {
    name: &'static str,
    /// Counts the jobs asked for and the stops: a job is wanted while it is the latest.
    generation: AtomicU64,
    state: Mutex<State<J>>,
    run: Run<J>,
}

struct State<J> {
    /// The job to run next, and its generation.
    next: Option<(u64, J)>,
    /// Whether the thread is alive; it ends when `next` is empty.
    running: bool,
}

impl<J: Send + 'static> LatestWorker<J> {
    /// `run` does one job; it checks the function it is given between steps,
    /// and returns soon after that says the job is no longer wanted.
    pub(super) fn new(name: &'static str, run: impl Fn(J, &dyn Fn() -> bool) + Send + Sync + 'static) -> Self {
        Self { inner: Arc::new(Inner {
            name,
            generation: AtomicU64::new(0),
            state: Mutex::new(State { next: None, running: false }),
            run: Box::new(run),
        }) }
    }

    /// Runs `job` in place of anything asked before: a job under way stops at
    /// its next check, and one still waiting is dropped unrun.
    pub(super) fn submit(&self, job: J) -> Result<()> {
        let mut state = self.inner.state.lock().unwrap();
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        state.next = Some((generation, job));
        if state.running {
            return Ok(());
        }
        let inner = self.inner.clone();
        // Started under the lock: the thread takes its first job once this returns.
        std::thread::Builder::new().name(self.inner.name.into()).spawn(move || work(&inner)).inspect_err(|_| {
            state.next = None;
        })?;
        state.running = true;
        Ok(())
    }

    /// Stops whatever runs or waits; nothing runs until the next `submit`.
    pub(super) fn stop(&self) {
        let mut state = self.inner.state.lock().unwrap();
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        state.next = None;
    }
}

fn work<J>(inner: &Inner<J>) {
    loop {
        let (generation, job) = {
            let mut state = inner.state.lock().unwrap();
            // Decided under the lock a `submit` takes: it either finds the
            // thread running and leaves its job here, or starts another.
            match state.next.take() {
                Some(next) => next,
                None => { state.running = false; return; }
            }
        };
        let wanted = || inner.generation.load(Ordering::SeqCst) == generation;
        if wanted() {
            (inner.run)(job, &wanted);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Barrier;
    use std::time::{Duration, Instant};

    /// What a test job does: waits at `started`, then works until it is no
    /// longer wanted or `release` says to finish.
    struct Job {
        name: &'static str,
        started: Option<Arc<Barrier>>,
    }

    #[derive(Default)]
    struct Record {
        active: AtomicUsize,
        most_active: AtomicUsize,
        ran: Mutex<Vec<&'static str>>,
        /// The jobs that saw they were no longer wanted, and how long after it was so they stopped.
        stopped: Mutex<Vec<(&'static str, Duration)>>,
        /// When the job under way stopped being wanted, as the test notes it.
        replaced_at: Mutex<Option<Instant>>,
        /// Sent after a job noticed it was no longer wanted: an obsolete send.
        late_sends: AtomicUsize,
        finished: Mutex<Vec<&'static str>>,
        release: std::sync::atomic::AtomicBool,
    }

    fn worker(record: &Arc<Record>) -> LatestWorker<Job> {
        let record = record.clone();
        LatestWorker::new("latest-worker-test", move |job: Job, wanted: &dyn Fn() -> bool| {
            let active = record.active.fetch_add(1, Ordering::SeqCst) + 1;
            record.most_active.fetch_max(active, Ordering::SeqCst);
            record.ran.lock().unwrap().push(job.name);
            if let Some(started) = &job.started {
                started.wait();
            }
            // As a whole-log hash checks between records.
            loop {
                if !wanted() {
                    let since = record.replaced_at.lock().unwrap().map_or(Duration::ZERO, |at| at.elapsed());
                    record.stopped.lock().unwrap().push((job.name, since));
                    break;
                }
                if record.release.load(Ordering::SeqCst) {
                    // The send is made only while still wanted.
                    if wanted() { record.finished.lock().unwrap().push(job.name); } else { record.late_sends.fetch_add(1, Ordering::SeqCst); }
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            record.active.fetch_sub(1, Ordering::SeqCst);
        })
    }

    fn settle(record: &Record, until: impl Fn(&Record) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !until(record) {
            assert!(Instant::now() < deadline, "the worker did not settle");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Requests that come while a prefetch runs never add a thread: the one
    /// under way stops at its next check, the ones in between never run, and
    /// the last one does.
    #[test]
    fn repeated_requests_run_one_at_a_time_and_only_the_latest() {
        let record = Arc::new(Record::default());
        let worker = worker(&record);
        let started = Arc::new(Barrier::new(2));
        worker.submit(Job { name: "first", started: Some(started.clone()) }).unwrap();
        // The first is at work.
        started.wait();
        *record.replaced_at.lock().unwrap() = Some(Instant::now());
        for name in ["second", "third", "fourth"] {
            worker.submit(Job { name, started: None }).unwrap();
        }
        let last = Arc::new(Barrier::new(2));
        worker.submit(Job { name: "last", started: Some(last.clone()) }).unwrap();
        last.wait();
        record.release.store(true, Ordering::SeqCst);
        settle(&record, |record| record.finished.lock().unwrap().len() == 1 && record.active.load(Ordering::SeqCst) == 0);

        assert_eq!(record.most_active.load(Ordering::SeqCst), 1, "one prefetch at work at a time");
        assert_eq!(*record.ran.lock().unwrap(), ["first", "last"], "the requests in between are never read");
        assert_eq!(*record.finished.lock().unwrap(), ["last"]);
        assert_eq!(record.late_sends.load(Ordering::SeqCst), 0, "nothing is sent for a replaced request");
        let stopped = record.stopped.lock().unwrap();
        assert_eq!(stopped.iter().map(|(name, _)| *name).collect::<Vec<_>>(), ["first"]);
        assert!(stopped[0].1 < Duration::from_secs(1), "the replaced prefetch stops at once: {:?}", stopped[0].1);
    }

    /// A stop ends the job under way and runs nothing more; a later request
    /// starts the thread again.
    #[test]
    fn a_stop_ends_the_job_and_a_later_request_runs_again() {
        let record = Arc::new(Record::default());
        let worker = worker(&record);
        let started = Arc::new(Barrier::new(2));
        worker.submit(Job { name: "first", started: Some(started.clone()) }).unwrap();
        started.wait();
        worker.stop();
        settle(&record, |record| record.stopped.lock().unwrap().len() == 1);
        settle(&record, |_| !worker.inner.state.lock().unwrap().running);
        assert_eq!(*record.ran.lock().unwrap(), ["first"]);

        record.release.store(true, Ordering::SeqCst);
        worker.submit(Job { name: "again", started: None }).unwrap();
        settle(&record, |record| record.finished.lock().unwrap().len() == 1);
        assert_eq!(*record.ran.lock().unwrap(), ["first", "again"]);
        assert_eq!(record.most_active.load(Ordering::SeqCst), 1);
        assert_eq!(record.late_sends.load(Ordering::SeqCst), 0);
    }
}
