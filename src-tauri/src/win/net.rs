//! Socket options Windows has and Unix does not.
use std::io;
use std::os::windows::io::AsRawSocket;

use windows_sys::Win32::Networking::WinSock::{setsockopt, WSAGetLastError, SOCKET, SOL_SOCKET, SO_EXCLUSIVEADDRUSE};

/// Make a socket's next bind refuse a port any other socket holds, on any
/// address. Without it a wildcard listener on Windows coexists with another
/// program's listener on one address, and that program keeps its traffic.
pub(crate) fn bind_exclusively(socket: &impl AsRawSocket) -> io::Result<()> {
    let on: i32 = 1;
    // SAFETY: `on` outlives the call and the length given is its size.
    let result = unsafe { setsockopt(socket.as_raw_socket() as SOCKET, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (&raw const on).cast(), size_of::<i32>() as i32) };
    if result == 0 {
        Ok(())
    } else {
        // SAFETY: WSAGetLastError has no preconditions.
        Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }))
    }
}
