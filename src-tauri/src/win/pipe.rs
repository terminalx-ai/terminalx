//! Named pipes as TerminalX uses them in place of Unix sockets.
//!
//! Every pipe is created with an owner-only DACL (this user and SYSTEM),
//! refuses remote clients, and is bounded in instances. The first instance of
//! a name is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a name another
//! process already serves is never shared with it.
//!
//! A client connects at the *identification* impersonation level, so no
//! server can act as it, and checks that the pipe object is owned by this
//! user and served by a process of this user before it sends a byte: a pipe
//! another account created first under a predictable name never receives a
//! credential.
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_NO_DATA,
    ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED};

use super::security::{verify_pipe_server, wide, Descriptor};

/// Instances one pipe name may have at once. A permission hook can hold its
/// connection while a person decides, so this is generous; it bounds what a
/// runaway client can make the server allocate.
pub(crate) const MAX_INSTANCES: usize = 128;

/// A server instance of `path` that only this user can open, from no other
/// machine. `first` claims the name: it fails when something already serves it.
pub(crate) fn server(path: &Path, first: bool) -> io::Result<NamedPipeServer> {
    let descriptor = Descriptor::owner_only()?;
    let mut attributes = descriptor.attributes();
    let mut options = ServerOptions::new();
    options.reject_remote_clients(true).first_pipe_instance(first).max_instances(MAX_INSTANCES);
    // SAFETY: `attributes` points at `descriptor`, both alive for the call;
    // the pipe keeps its own copy of the security descriptor.
    unsafe { options.create_with_security_attributes_raw(path, std::ptr::addr_of_mut!(attributes).cast()) }
}

/// Whether a connect failed only because that client has already gone: it
/// opened the waiting instance and closed it before the connect was seen.
fn client_left(error: &io::Error) -> bool {
    matches!(error.raw_os_error().map(|code| code as u32), Some(ERROR_NO_DATA | ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED))
}

/// The next client of `server`, an instance of `path`, which is replaced by a
/// fresh one waiting for the client after. A client that is gone before it is
/// served, or that runs as another account, is passed over; only an instance
/// that cannot be made again ends the wait with an error. Cancel-safe: its one
/// await is the connect, which tokio documents as cancel-safe.
pub(crate) async fn accept(server: &mut NamedPipeServer, path: &Path) -> io::Result<NamedPipeServer> {
    loop {
        match server.connect().await {
            Ok(()) => {
                let next = match self::server(path, false) {
                    Ok(next) => next,
                    Err(error) => {
                        // Not handed out again by the next call: this client is dropped.
                        let _ = server.disconnect();
                        return Err(error);
                    }
                };
                let connected = std::mem::replace(server, next);
                match super::security::verify_pipe_client(&connected) {
                    Ok(_) => return Ok(connected),
                    Err(error) => log::warn!("refused a client of {}: {error}", path.display()),
                }
            }
            Err(error) if client_left(&error) => {
                *server = self::server(path, false)?;
            }
            Err(error) => return Err(error),
        }
    }
}

/// A connected, blocking end of a named pipe, with the read and write
/// timeouts and `try_clone`/`shutdown` a `UnixStream` has. Clones share the
/// pipe; each keeps its own timeouts.
pub struct PipeStream {
    inner: Arc<Inner>,
    read_timeout: Mutex<Option<Duration>>,
    write_timeout: Mutex<Option<Duration>>,
}

/// The pipe handle and who is using it. A shut-down pipe's handle is closed
/// once no transfer is using it, so the other end reads the end of the
/// stream, as after `shutdown(Both)` on a socket; it is never closed under a
/// transfer, whose handle value could otherwise be reused.
struct Inner {
    shut: AtomicBool,
    state: Mutex<State>,
}

struct State {
    handle: Option<OwnedHandle>,
    active: usize,
}

impl Inner {
    fn new(handle: OwnedHandle) -> Arc<Self> {
        Arc::new(Self { shut: AtomicBool::new(false), state: Mutex::new(State { handle: Some(handle), active: 0 }) })
    }

    /// The handle, held for one transfer; `None` once shut down.
    fn enter(&self) -> Option<HANDLE> {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.shut.load(Ordering::SeqCst) {
            return None;
        }
        let handle = state.handle.as_ref()?.as_raw_handle() as HANDLE;
        state.active += 1;
        Some(handle)
    }

    fn leave(&self) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active -= 1;
        Self::close_if_idle(&mut state, &self.shut);
    }

    fn close_if_idle(state: &mut State, shut: &AtomicBool) {
        if shut.load(Ordering::SeqCst) && state.active == 0 {
            if let Some(handle) = state.handle.take() {
                // SAFETY: a live handle no transfer is using.
                unsafe { FlushFileBuffers(handle.as_raw_handle() as HANDLE) };
                drop(handle);
            }
        }
    }

    fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        self.shut.store(true, Ordering::SeqCst);
        if let Some(handle) = state.handle.as_ref() {
            // SAFETY: cancels this handle's pending transfers, on every thread.
            unsafe { CancelIoEx(handle.as_raw_handle() as HANDLE, std::ptr::null()) };
        }
        Self::close_if_idle(&mut state, &self.shut);
    }

    fn raw(&self) -> RawHandle {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.handle.as_ref().map_or(INVALID_HANDLE_VALUE as RawHandle, |handle| handle.as_raw_handle())
    }
}

struct Event(OwnedHandle);

impl Event {
    fn new() -> io::Result<Self> {
        // SAFETY: an unnamed manual-reset event, owned below.
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh handle nobody else owns.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
    }
}

fn millis(timeout: Option<Duration>) -> u32 {
    match timeout {
        // INFINITE.
        None => u32::MAX,
        Some(timeout) => timeout.as_millis().clamp(1, u32::MAX as u128 - 1) as u32,
    }
}

impl PipeStream {
    fn wrap(handle: OwnedHandle) -> Self {
        Self { inner: Inner::new(handle), read_timeout: Mutex::new(None), write_timeout: Mutex::new(None) }
    }

    /// Connect to `path`, waiting while every instance is busy, and refuse a
    /// pipe that is not this user's own.
    pub(crate) fn connect(path: &Path) -> io::Result<Self> {
        Self::connect_within(path, Duration::from_secs(5))
    }

    pub(crate) fn connect_within(path: &Path, wait: Duration) -> io::Result<Self> {
        let name = wide(path.as_os_str());
        let deadline = Instant::now() + wait;
        loop {
            // SAFETY: `name` is NUL-terminated; the handle is owned below.
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                // SAFETY: a fresh handle nobody else owns.
                let handle = unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) };
                verify_pipe_server(&handle)?;
                return Ok(Self::wrap(handle));
            }
            // SAFETY: this thread's error from the failed call above.
            let error = unsafe { GetLastError() };
            let left = deadline.saturating_duration_since(Instant::now());
            match error {
                ERROR_PIPE_BUSY if !left.is_zero() => {
                    // SAFETY: as above; a timeout or a vanished pipe just loops.
                    unsafe { WaitNamedPipeW(name.as_ptr(), millis(Some(left))) };
                }
                ERROR_FILE_NOT_FOUND => {
                    return Err(io::Error::new(io::ErrorKind::ConnectionRefused, format!("nothing listens at {}", path.display())))
                }
                ERROR_PIPE_BUSY => return Err(io::Error::new(io::ErrorKind::TimedOut, "every pipe instance stayed busy")),
                error => return Err(io::Error::from_raw_os_error(error as i32)),
            }
        }
    }

    pub(crate) fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        *self.read_timeout.lock().unwrap() = timeout;
        Ok(())
    }

    pub(crate) fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        *self.write_timeout.lock().unwrap() = timeout;
        Ok(())
    }

    pub(crate) fn try_clone(&self) -> io::Result<Self> {
        Ok(Self {
            inner: self.inner.clone(),
            read_timeout: Mutex::new(*self.read_timeout.lock().unwrap()),
            write_timeout: Mutex::new(*self.write_timeout.lock().unwrap()),
        })
    }

    /// End every read and write on this pipe, from any clone, and let the
    /// other end read the end of the stream: what `UnixStream::shutdown(Both)`
    /// does.
    pub(crate) fn shutdown(&self) -> io::Result<()> {
        self.inner.shutdown();
        Ok(())
    }

    /// Run one overlapped transfer to completion, cancelling it at `timeout`
    /// or on shutdown. `None`: the pipe was shut down before it started.
    fn transfer(&self, timeout: Option<Duration>, start: impl FnOnce(HANDLE, *mut OVERLAPPED) -> i32) -> Option<io::Result<usize>> {
        let handle = self.inner.enter()?;
        let result = (|| {
            let event = Event::new()?;
            let mut overlapped = OVERLAPPED { hEvent: event.0.as_raw_handle() as HANDLE, ..Default::default() };
            let mut done = 0u32;
            if start(handle, &mut overlapped) != 0 {
                // Completed at once.
                // SAFETY: the transfer has completed; this only reads its count.
                if unsafe { GetOverlappedResult(handle, &overlapped, &mut done, 1) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                return Ok(done as usize);
            }
            // SAFETY: this thread's error from the call just made.
            let error = unsafe { GetLastError() };
            if error != ERROR_IO_PENDING {
                return Err(io::Error::from_raw_os_error(error as i32));
            }
            // A shutdown between taking the handle and issuing the transfer
            // cancelled nothing of it; it is cancelled here instead.
            if self.inner.shut.load(Ordering::SeqCst) {
                // SAFETY: cancels this one transfer, waited out below.
                unsafe { CancelIoEx(handle, &overlapped) };
            }
            // SAFETY: `overlapped` stays alive until the transfer completes:
            // either here, or after the cancel below is waited out.
            if unsafe { GetOverlappedResultEx(handle, &overlapped, &mut done, millis(timeout), 0) } != 0 {
                return Ok(done as usize);
            }
            // SAFETY: as above.
            let error = unsafe { GetLastError() };
            if error != WAIT_TIMEOUT {
                return Err(io::Error::from_raw_os_error(error as i32));
            }
            // SAFETY: cancel this one transfer, then wait for it to settle so
            // `overlapped` is no longer in use. It may have completed in
            // between: then its bytes are the result, not lost.
            unsafe { CancelIoEx(handle, &overlapped) };
            // SAFETY: as above.
            if unsafe { GetOverlappedResult(handle, &overlapped, &mut done, 1) } != 0 {
                return Ok(done as usize);
            }
            Err(io::Error::new(io::ErrorKind::TimedOut, "pipe transfer timed out"))
        })();
        self.inner.leave();
        Some(result)
    }

    fn shut(&self) -> bool {
        self.inner.shut.load(Ordering::SeqCst)
    }
}

fn len(buf: usize) -> u32 {
    buf.min(u32::MAX as usize) as u32
}

impl Read for PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let timeout = *self.read_timeout.lock().unwrap();
        // SAFETY: `buf` outlives the transfer, which `transfer` waits out.
        let result = self.transfer(timeout, |handle, overlapped| unsafe {
            ReadFile(handle, buf.as_mut_ptr(), len(buf.len()), std::ptr::null_mut(), overlapped)
        });
        match result {
            None => Ok(0),
            Some(Err(error)) if matches!(error.raw_os_error().map(|code| code as u32), Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED)) => Ok(0),
            Some(Err(error)) if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) && self.shut() => Ok(0),
            Some(other) => other,
        }
    }
}

impl Write for PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let timeout = *self.write_timeout.lock().unwrap();
        // SAFETY: `buf` outlives the transfer, which `transfer` waits out.
        let result = self.transfer(timeout, |handle, overlapped| unsafe {
            WriteFile(handle, buf.as_ptr(), len(buf.len()), std::ptr::null_mut(), overlapped)
        });
        match result {
            None => Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe was shut down")),
            Some(Err(error)) if matches!(error.raw_os_error().map(|code| code as u32), Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED)) => {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, error))
            }
            Some(Err(error)) if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) && self.shut() => {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe was shut down"))
            }
            Some(other) => other,
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for &PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut clone = PipeStream { inner: self.inner.clone(), read_timeout: Mutex::new(*self.read_timeout.lock().unwrap()), write_timeout: Mutex::new(None) };
        clone.read(buf)
    }
}

impl Write for &PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut clone = PipeStream { inner: self.inner.clone(), read_timeout: Mutex::new(None), write_timeout: Mutex::new(*self.write_timeout.lock().unwrap()) };
        clone.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A blocking server for one pipe name, as a `UnixListener` is for a socket
/// path: owner-only, local clients only, and every accepted client is checked
/// to run as this user.
#[cfg(test)]
pub struct Listener {
    path: std::path::PathBuf,
    /// The instance waiting for the next client.
    pending: Mutex<Option<OwnedHandle>>,
}

#[cfg(test)]
fn instance(path: &Path, first: bool) -> io::Result<OwnedHandle> {
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT};
    let descriptor = Descriptor::owner_only()?;
    let attributes = descriptor.attributes();
    let name = wide(path.as_os_str());
    let mut open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if first {
        open |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    // SAFETY: `name` is NUL-terminated and `attributes` points at
    // `descriptor`, both alive for the call; the handle is owned below.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            MAX_INSTANCES as u32,
            64 * 1024,
            64 * 1024,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh handle nobody else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
}

#[cfg(test)]
impl Listener {
    /// Claim `path`: fails when another process already serves it.
    pub(crate) fn bind(path: &Path) -> io::Result<Self> {
        Ok(Self { path: path.to_owned(), pending: Mutex::new(Some(instance(path, true)?)) })
    }

    /// Wait for the next client, passing over one that is already gone or
    /// runs as another account.
    pub(crate) fn accept(&self) -> io::Result<PipeStream> {
        use windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED;
        use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
        loop {
            let handle = match self.pending.lock().unwrap().take() {
                Some(handle) => handle,
                None => instance(&self.path, false)?,
            };
            let raw = handle.as_raw_handle() as HANDLE;
            let event = Event::new()?;
            let mut overlapped = OVERLAPPED { hEvent: event.0.as_raw_handle() as HANDLE, ..Default::default() };
            // SAFETY: `overlapped` lives until the connect completes below.
            let connected = unsafe { ConnectNamedPipe(raw, &mut overlapped) } != 0;
            if !connected {
                // SAFETY: this thread's error from the call above.
                match unsafe { GetLastError() } {
                    ERROR_PIPE_CONNECTED => {}
                    ERROR_IO_PENDING => {
                        let mut done = 0;
                        // SAFETY: waits for the connect `overlapped` describes.
                        if unsafe { GetOverlappedResult(raw, &overlapped, &mut done, 1) } == 0 {
                            let error = io::Error::last_os_error();
                            if client_left(&error) { continue; }
                            return Err(error);
                        }
                    }
                    error => {
                        let error = io::Error::from_raw_os_error(error as i32);
                        if client_left(&error) { continue; }
                        return Err(error);
                    }
                }
            }
            *self.pending.lock().unwrap() = Some(instance(&self.path, false)?);
            let stream = PipeStream::wrap(handle);
            match super::security::verify_pipe_client(&stream) {
                Ok(_) => return Ok(stream),
                Err(error) => log::warn!("refused a pipe client on {}: {error}", self.path.display()),
            }
        }
    }

    /// Every client, as `UnixListener::incoming` gives them.
    pub(crate) fn incoming(&self) -> impl Iterator<Item = io::Result<PipeStream>> + '_ {
        std::iter::from_fn(move || Some(self.accept()))
    }
}

impl AsRawHandle for PipeStream {
    fn as_raw_handle(&self) -> RawHandle {
        self.inner.raw()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    fn name() -> std::path::PathBuf {
        std::path::PathBuf::from(format!(r"\\.\pipe\terminalx-test-{}", uuid::Uuid::new_v4()))
    }

    /// Serves one echo connection per accepted client, on its own runtime,
    /// through the same `accept` the app's listeners use.
    fn echo(path: std::path::PathBuf) {
        let (ready, started) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async move {
                let mut server = server(&path, true).unwrap();
                ready.send(()).unwrap();
                while let Ok(connected) = accept(&mut server, &path).await {
                    tokio::spawn(async move {
                        let (read, mut write) = tokio::io::split(connected);
                        let mut lines = tokio::io::BufReader::new(read).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            if line == "hang" {
                                tokio::time::sleep(Duration::from_secs(30)).await;
                            }
                            let _ = write.write_all(format!("{line}\n").as_bytes()).await;
                        }
                    });
                }
            });
        });
        started.recv().unwrap();
    }

    #[test]
    fn a_client_talks_times_out_and_is_shut_down_from_another_thread() {
        let path = name();
        echo(path.clone());
        let mut stream = PipeStream::connect(&path).unwrap();
        stream.write_all(b"hello\n").unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, "hello\n");

        stream.write_all(b"hang\n").unwrap();
        reader.get_ref().set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        let error = reader.read_line(&mut String::new()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);

        reader.get_ref().set_read_timeout(None).unwrap();
        let shut = stream.try_clone().unwrap();
        let blocked = std::thread::spawn(move || reader.read_line(&mut String::new()).unwrap());
        std::thread::sleep(Duration::from_millis(100));
        shut.shutdown().unwrap();
        assert_eq!(blocked.join().unwrap(), 0, "a shut-down pipe reads as closed");
        assert!(stream.write_all(b"after\n").is_err());
        assert_eq!(stream.read(&mut [0u8; 4]).unwrap(), 0, "and goes on reading as closed");
    }

    #[test]
    fn a_shut_down_end_is_read_as_closed_by_the_other_end() {
        let path = name();
        let listener = Listener::bind(&path).unwrap();
        let serving = std::thread::spawn(move || {
            let mut server = listener.accept().unwrap();
            let mut all = Vec::new();
            server.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            server.read_to_end(&mut all).unwrap();
            all
        });
        let mut client = PipeStream::connect(&path).unwrap();
        let kept = client.try_clone().unwrap();
        client.write_all(b"last words").unwrap();
        client.shutdown().unwrap();
        assert_eq!(serving.join().unwrap(), b"last words", "the far end sees the end of the stream while a clone lives");
        drop(kept);
    }

    #[test]
    fn a_client_that_leaves_before_it_is_served_does_not_stop_the_listener() {
        let path = name();
        echo(path.clone());
        for _ in 0..5 {
            drop(PipeStream::connect(&path).unwrap());
        }
        let mut stream = PipeStream::connect(&path).unwrap();
        stream.write_all(b"still here\n").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        assert_eq!(line, "still here\n");

        let blocking = name();
        let listener = Listener::bind(&blocking).unwrap();
        drop(PipeStream::connect(&blocking).unwrap());
        let serving = std::thread::spawn(move || {
            let mut server = listener.accept().unwrap();
            let mut text = String::new();
            BufReader::new(&mut server).read_line(&mut text).unwrap();
            text
        });
        std::thread::sleep(Duration::from_millis(100));
        PipeStream::connect(&blocking).unwrap().write_all(b"after\n").unwrap();
        assert_eq!(serving.join().unwrap(), "after\n");
    }

    #[test]
    fn a_second_first_instance_and_a_missing_pipe_are_refused() {
        let path = name();
        echo(path.clone());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async { assert!(server(&path, true).is_err(), "the name is already served") });
        let missing = PipeStream::connect(&name()).err().unwrap();
        assert_eq!(missing.kind(), io::ErrorKind::ConnectionRefused);
    }
}
