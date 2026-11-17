//! Inherited descriptors for the sealed cua role. No pathname or public socket
//! is consulted. All descriptors become CLOEXEC before any harness can run.
#[cfg(target_os = "linux")]
use anyhow::Context as _;
use anyhow::{ensure, Result};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const STALL: Duration = Duration::from_secs(30);

pub(super) struct Channel {
    stream: OwnedFd,
    lifetime: OwnedFd,
    fenced: bool,
    frame_deadline: Option<Instant>,
}

/// Independent of request dispatch: owner loss must revoke admission even
/// while a provider call is blocked. The callback initiates shutdown through
/// retained child handles; it must not wait for the dispatch mutex. Revocation
/// is not child-exit proof, and no success receipt is manufactured here.
pub(super) struct LifetimeMonitor {
    state: Arc<Revocation>,
    stop: Option<OwnedFd>,
    thread: Option<std::thread::JoinHandle<()>>,
}

struct Revocation {
    revoked: AtomicBool,
    stream: OwnedFd,
    shutdown: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl Revocation {
    fn revoke(&self) {
        if !self.revoked.swap(true, Ordering::AcqRel) {
            // SAFETY: the socket remains owned until the watcher exits.
            unsafe {
                libc::shutdown(self.stream.as_raw_fd(), libc::SHUT_RDWR);
            }
            let callback = self.shutdown.lock().unwrap().take();
            if let Some(callback) = callback {
                callback();
            }
        }
    }
}

impl LifetimeMonitor {
    pub fn check(&self) -> Result<()> {
        ensure!(
            !self.state.revoked.load(Ordering::Acquire),
            "worker lifetime revoked"
        );
        Ok(())
    }

    pub fn revoke(&self) {
        self.state.revoke();
    }
}

impl Drop for LifetimeMonitor {
    fn drop(&mut self) {
        // Closing this private pipe wakes the watcher without signaling any PID.
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn private_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    use std::os::fd::FromRawFd;
    let mut fds = [-1; 2];
    // SAFETY: pipe writes two fresh descriptors to the provided array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: each descriptor is adopted once, including on flag errors.
    let pair = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in [&pair.0, &pair.1] {
        set_flags(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC)?;
    }
    Ok(pair)
}

fn flags(fd: RawFd, command: i32) -> io::Result<i32> {
    // SAFETY: fcntl queries only the supplied descriptor.
    let value = unsafe { libc::fcntl(fd, command) };
    if value < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(value)
    }
}
fn set_flags(fd: RawFd, command: i32, value: i32) -> io::Result<()> {
    // SAFETY: fcntl flag setters have no pointer arguments.
    if unsafe { libc::fcntl(fd, command, value) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

impl Channel {
    pub fn watch_lifetime(
        &self,
        shutdown: impl FnOnce() + Send + 'static,
    ) -> Result<LifetimeMonitor> {
        let lifetime = self.lifetime.try_clone()?;
        let stream = self.stream.try_clone()?;
        let (stop_read, stop_write) = private_pipe()?;
        let state = Arc::new(Revocation {
            revoked: AtomicBool::new(false),
            stream,
            shutdown: Mutex::new(Some(Box::new(shutdown))),
        });
        let signal = state.clone();
        let thread = std::thread::Builder::new()
            .name("guest-worker-lifetime".into())
            .spawn(move || {
                let mut fds = [
                    libc::pollfd {
                        fd: lifetime.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    },
                    libc::pollfd {
                        fd: stop_read.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    },
                    // No POLLIN: queued commands are not owner loss. HUP/ERR are
                    // reported even with events=0, without consuming protocol bytes.
                    libc::pollfd {
                        fd: signal.stream.as_raw_fd(),
                        #[cfg(target_os = "linux")]
                        events: libc::POLLRDHUP,
                        #[cfg(not(target_os = "linux"))]
                        events: 0,
                        revents: 0,
                    },
                ];
                loop {
                    // SAFETY: fds lives for the blocking poll call.
                    let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, -1) };
                    if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
                    {
                        continue;
                    }
                    if result >= 0
                        && fds[0].revents == 0
                        && fds[2].revents == 0
                        && fds[1].revents != 0
                    {
                        return;
                    }
                    if result < 0 || fds[0].revents != 0 || fds[2].revents != 0 {
                        // Wake a concurrent protocol read/write, then start child
                        // shutdown without waiting for a blocked operation to return.
                        signal.revoke();
                        return;
                    }
                }
            })?;
        Ok(LifetimeMonitor {
            state,
            stop: Some(stop_write),
            thread: Some(thread),
        })
    }

    pub fn new(stream: OwnedFd, lifetime: OwnedFd) -> Result<Self> {
        let fd = stream.as_raw_fd();
        let life = lifetime.as_raw_fd();
        let mut kind = 0i32;
        let mut len = std::mem::size_of_val(&kind) as libc::socklen_t;
        // SAFETY: kind/len are writable and correctly sized for SO_TYPE.
        ensure!(
            unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    (&mut kind as *mut i32).cast(),
                    &mut len,
                )
            } == 0
                && kind == libc::SOCK_STREAM,
            "worker IPC must be a stream socket"
        );
        let mut address = unsafe { std::mem::zeroed::<libc::sockaddr_storage>() };
        let mut len = std::mem::size_of_val(&address) as libc::socklen_t;
        // getpeername also refuses an unconnected/listening socket. SO_PEERCRED
        // is intentionally not used as proof of post-fork process credentials.
        ensure!(
            unsafe {
                libc::getpeername(
                    fd,
                    (&mut address as *mut libc::sockaddr_storage).cast(),
                    &mut len,
                )
            } == 0
                && address.ss_family as i32 == libc::AF_UNIX,
            "worker IPC must be connected AF_UNIX"
        );
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        ensure!(
            unsafe { libc::fstat(life, &mut stat) } == 0
                && stat.st_mode & libc::S_IFMT == libc::S_IFIFO,
            "worker lifetime must be a pipe"
        );
        ensure!(
            flags(life, libc::F_GETFL)? & libc::O_ACCMODE == libc::O_RDONLY,
            "worker lifetime must be read-only"
        );
        for fd in [fd, life] {
            set_flags(
                fd,
                libc::F_SETFD,
                flags(fd, libc::F_GETFD)? | libc::FD_CLOEXEC,
            )?;
            set_flags(
                fd,
                libc::F_SETFL,
                flags(fd, libc::F_GETFL)? | libc::O_NONBLOCK,
            )?;
        }
        Ok(Self {
            stream,
            lifetime,
            fenced: false,
            frame_deadline: None,
        })
    }

    fn ready(&mut self, events: i16, deadline: Instant) -> io::Result<()> {
        if self.fenced {
            return Err(io::Error::other("worker channel fenced"));
        }
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return self.fail(io::ErrorKind::TimedOut);
            }
            let mut fds = [
                libc::pollfd {
                    fd: self.lifetime.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.stream.as_raw_fd(),
                    events,
                    revents: 0,
                },
            ];
            let count = unsafe {
                libc::poll(
                    fds.as_mut_ptr(),
                    2,
                    remaining.as_millis().min(i32::MAX as u128) as i32,
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                self.fenced = true;
                return Err(error);
            }
            // Lifetime is one-way and carries no messages. Data, HUP, EOF or
            // an invalid descriptor all revoke admission before readable IPC.
            if fds[0].revents != 0 {
                return self.fail(io::ErrorKind::BrokenPipe);
            }
            if fds[1].revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return self.fail(io::ErrorKind::BrokenPipe);
            }
            if fds[1].revents & (events | libc::POLLHUP) != 0 {
                return Ok(());
            }
        }
    }
    fn fail<T>(&mut self, kind: io::ErrorKind) -> io::Result<T> {
        self.fenced = true;
        Err(io::Error::new(kind, "worker owner channel lost"))
    }
}
impl Read for Channel {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let deadline = self
            .frame_deadline
            .unwrap_or_else(|| Instant::now() + STALL);
        loop {
            self.ready(libc::POLLIN, deadline)?;
            let count = unsafe {
                libc::read(
                    self.stream.as_raw_fd(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                )
            };
            if count > 0 {
                return Ok(count as usize);
            }
            if count == 0 {
                return self.fail(io::ErrorKind::UnexpectedEof);
            }
            let error = io::Error::last_os_error();
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) {
                continue;
            }
            self.fenced = true;
            return Err(error);
        }
    }
}
impl Write for Channel {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let deadline = self
            .frame_deadline
            .unwrap_or_else(|| Instant::now() + STALL);
        loop {
            self.ready(libc::POLLOUT, deadline)?;
            // MSG_NOSIGNAL avoids killing the runtime before it can initiate
            // retained-child shutdown after an owner disconnect.
            let count = unsafe {
                libc::send(
                    self.stream.as_raw_fd(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    libc::MSG_NOSIGNAL,
                )
            };
            if count > 0 {
                return Ok(count as usize);
            }
            if count == 0 {
                return self.fail(io::ErrorKind::WriteZero);
            }
            let error = io::Error::last_os_error();
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) {
                continue;
            }
            self.fenced = true;
            return Err(error);
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.fenced {
            return Err(io::Error::other("worker channel fenced"));
        }
        Ok(())
    }
}

/// Only the launcher-created worker entrypoint may call this, before threads.
/// No owner files are opened and no environment value can select descriptors.
#[cfg(target_os = "linux")]
pub(super) fn inherited() -> Result<Channel> {
    use std::os::fd::FromRawFd;
    super::super::guest_account::check_linux_worker()?;
    ensure!(
        std::env::args().skip(1).eq(["local-vm-worker"]),
        "invalid worker argv"
    );
    flags(3, libc::F_GETFD).context("missing IPC descriptor")?;
    flags(4, libc::F_GETFD).context("missing lifetime descriptor")?;
    ensure!(
        std::fs::read_dir("/proc/self/task")?.count() == 1,
        "worker descriptors must be adopted before threads start"
    );
    for fd in 0..=2 {
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        ensure!(
            unsafe { libc::fstat(fd, &mut stat) } == 0
                && stat.st_mode & libc::S_IFMT == libc::S_IFCHR
                && stat.st_rdev == libc::makedev(1, 3),
            "worker stdio must be null"
        );
    }
    // Defense in depth after launcher closure; no accidental owner handle may
    // reach hooks/providers. This is single-threaded and does not touch 0..4.
    ensure!(
        unsafe { libc::syscall(libc::SYS_close_range, 5u32, u32::MAX, 0u32) } == 0,
        "cannot close inherited worker descriptors"
    );
    // SAFETY: this dedicated startup path consumes the launcher's fixed pair
    // exactly once. They are valid descriptors, verified immediately above.
    Channel::new(unsafe { OwnedFd::from_raw_fd(3) }, unsafe {
        OwnedFd::from_raw_fd(4)
    })
}

impl super::DeadlineIo for Channel {
    fn set_deadline(&mut self, deadline: Instant) -> io::Result<()> {
        super::time_left(deadline)?;
        self.frame_deadline = Some(deadline);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;
    use std::os::unix::net::UnixStream;
    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }
    #[test]
    fn descriptor_types_are_checked_and_both_handles_are_cloexec() {
        let (stream, _peer) = UnixStream::pair().unwrap();
        let (read, _write) = pipe();
        let channel = Channel::new(stream.into(), read).unwrap();
        for fd in [channel.stream.as_raw_fd(), channel.lifetime.as_raw_fd()] {
            assert_ne!(flags(fd, libc::F_GETFD).unwrap() & libc::FD_CLOEXEC, 0);
        }
        let (stream, _) = UnixStream::pair().unwrap();
        let (_, write) = pipe();
        assert!(Channel::new(stream.into(), write).is_err());
        let (read, write) = pipe();
        assert!(Channel::new(read, write).is_err());
    }
    #[test]
    fn lifetime_loss_precedes_pending_request_bytes_and_permanently_fences() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let (read, write) = pipe();
        let mut channel = Channel::new(stream.into(), read).unwrap();
        peer.write_all(b"queued operation").unwrap();
        drop(write);
        assert!(channel.read(&mut [0; 32]).is_err());
        assert!(channel.write(b"receipt").is_err());
    }
    #[test]
    fn ipc_eof_also_fences_while_lifetime_remains_open() {
        let (stream, peer) = UnixStream::pair().unwrap();
        let (read, _write) = pipe();
        let mut channel = Channel::new(stream.into(), read).unwrap();
        drop(peer);
        assert!(channel.read(&mut [0; 1]).is_err());
        assert!(channel.fenced);
    }
}
