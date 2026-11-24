use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;

use tokio::net::{TcpListener, TcpSocket};
use tokio::sync::mpsc;

use super::model::PairingConnectionMode;

pub(super) const PORT: u16 = 6768;
const BIND_ATTEMPTS: usize = 5;
pub(super) const RETRY_DELAY: Duration = Duration::from_secs(1);

/// Every interface on `port`.
#[cfg(test)]
pub(super) fn bind(port: u16) -> io::Result<TcpListener> {
    bind_address(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
}

fn bind_address(address: SocketAddr) -> io::Result<TcpListener> {
    let socket = TcpSocket::new_v4()?;
    // Keep exclusive binding. On macOS SO_REUSEADDR would let this wildcard
    // listener coexist with another program's interface-specific listener,
    // so an advertised address could still reach the other program. Windows
    // allows that coexistence by default, so there it is refused explicitly.
    #[cfg(windows)]
    crate::win::net::bind_exclusively(&socket)?;
    socket.bind(address)?;
    socket.listen(1024)
}

/// One listener on `port` per address in `addresses`, the ones the listen
/// setting binds (PRO-487, `crate::listen`). None is `AddrNotAvailable`:
/// "Relay only", or no address of the chosen kind now. All or nothing: a
/// failure closes the ones already bound.
pub(super) fn bind_each(addresses: &[Ipv4Addr], port: u16) -> io::Result<Vec<TcpListener>> {
    if addresses.is_empty() {
        return Err(io::Error::new(io::ErrorKind::AddrNotAvailable, "the listen setting opens no address on this Mac"));
    }
    addresses.iter().map(|address| bind_address(SocketAddr::from((*address, port)))).collect()
}

/// The sockets open on the window's own listeners, each with the address it
/// came from, from the moment it is accepted: handshaking, waiting for
/// approval, a logged-in phone or a shared session alike. The runtime's
/// machine host tracks its own the same way (`machine_host::Via`), so that a
/// caller let in under one listen plan does not outlive it (PRO-495).
///
/// Whether public callers are answered is kept under the same lock as the
/// sockets: a socket accepted while the setting changes is either refused
/// when it is noted or closed by the change, never missed by both.
#[derive(Default)]
pub(super) struct Callers {
    state: Mutex<CallersState>,
}

#[derive(Default)]
struct CallersState {
    /// `machines.allowPublic` as the window last read it; refused until then.
    allow_public: bool,
    next: u64,
    open: HashMap<u64, (IpAddr, mpsc::UnboundedSender<()>)>,
}

/// Forgets its socket when the socket's handler returns or is dropped.
pub(super) struct OpenCaller<'a> {
    callers: &'a Callers,
    id: u64,
}

impl Drop for OpenCaller<'_> {
    fn drop(&mut self) {
        self.callers.state.lock().unwrap().open.remove(&self.id);
    }
}

impl Callers {
    /// Note a socket from `source`, unless the plan does not answer it now.
    /// The receiver hears once when the socket is to be closed.
    pub(super) fn open(&self, source: IpAddr) -> Option<(OpenCaller<'_>, mpsc::UnboundedReceiver<()>)> {
        let mut state = self.state.lock().unwrap();
        if !crate::listen::caller_allowed(source, state.allow_public) {
            return None;
        }
        let (close, closed) = mpsc::unbounded_channel();
        let id = state.next;
        state.next += 1;
        state.open.insert(id, (source, close));
        Some((OpenCaller { callers: self, id }, closed))
    }

    /// Follow `machines.allowPublic`: from now on, and for the sockets
    /// already open, which are closed when the plan no longer answers their
    /// address. How many were closed.
    pub(super) fn answer_public(&self, allow_public: bool) -> usize {
        let mut state = self.state.lock().unwrap();
        state.allow_public = allow_public;
        state.close(|source| !crate::listen::caller_allowed(source, allow_public))
    }

    /// Close every socket: the listeners they came in on are closing.
    pub(super) fn close_all(&self) -> usize {
        self.state.lock().unwrap().close(|_| true)
    }

    /// The addresses of the sockets open now, sorted.
    #[cfg(test)]
    pub(super) fn sources(&self) -> Vec<IpAddr> {
        let mut sources: Vec<_> = self.state.lock().unwrap().open.values().map(|(source, _)| *source).collect();
        sources.sort_unstable();
        sources
    }
}

impl CallersState {
    /// Tell each socket `refused` names to close. They leave `open` as
    /// their handlers end; a second pass tells them again, harmlessly.
    fn close(&self, refused: impl Fn(IpAddr) -> bool) -> usize {
        self.open.values().filter(|(source, close)| refused(*source) && close.send(()).is_ok()).count()
    }
}

/// Relay must not wait for or depend on its optional nearby listener. LAN
/// gives an exiting app four seconds to release the port before failing.
pub(super) async fn prepare(
    mode: PairingConnectionMode,
    mut start: impl FnMut() -> io::Result<()>,
) -> anyhow::Result<bool> {
    for attempt in 1..=BIND_ATTEMPTS {
        match start() {
            Ok(()) => return Ok(true),
            Err(error) if mode == PairingConnectionMode::Automatic => {
                log::debug!("nearby pairing unavailable; continuing through Relay: {error}");
                return Ok(false);
            }
            Err(error) if crate::listen::port_taken(&error) && attempt < BIND_ATTEMPTS => {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(error) => {
                log::warn!("LAN pairing listener failed: {error}");
                let message = match error.kind() {
                    _ if crate::listen::port_taken(&error) => format!(
                        "Another program, or another copy of TerminalX, is using port {PORT}. Close it and retry."
                    ),
                    io::ErrorKind::PermissionDenied => format!(
                        "TerminalX does not have permission to use port {PORT} for LAN pairing."
                    ),
                    io::ErrorKind::AddrNotAvailable => "This Mac opens no port for nearby pairing: Settings → Machines → \"Where this Mac listens\" is Relay only, or names an address this Mac does not have now. Choose Local network there, or use TerminalX Relay.".into(),
                    _ => "TerminalX could not start LAN pairing. Try again, or use TerminalX Relay.".into(),
                };
                anyhow::bail!(message);
            }
        }
    }
    unreachable!("the final bind attempt returns its result")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn direct_binding_refuses_a_port_owned_by_a_loopback_listener() {
        let occupied = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert_eq!(bind(port).unwrap_err().kind(), io::ErrorKind::AddrInUse);
    }

    #[tokio::test]
    async fn relay_continues_immediately_when_another_listener_owns_the_port() {
        let occupied = bind(0).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let mut attempts = 0;
        let available = tokio::time::timeout(
            Duration::from_millis(500),
            prepare(PairingConnectionMode::Automatic, || {
                attempts += 1;
                bind(port).map(drop)
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!available);
        assert_eq!(attempts, 1);
    }

    #[tokio::test]
    async fn lan_recovers_when_the_previous_listener_exits() {
        let mut occupied = Some(bind(0).unwrap());
        let port = occupied.as_ref().unwrap().local_addr().unwrap().port();
        let mut attempts = 0;
        let available = prepare(PairingConnectionMode::LocalOnly, || {
            attempts += 1;
            let result = bind(port).map(drop);
            // Simulate an older app finishing shutdown after the first bind.
            drop(occupied.take());
            result
        })
        .await
        .unwrap();
        assert!(available);
        assert_eq!(attempts, 2);
    }

    #[tokio::test]
    async fn lan_reports_an_actionable_error_after_bounded_retries() {
        let occupied = bind(0).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let mut attempts = 0;
        let error = prepare(PairingConnectionMode::LocalOnly, || {
            attempts += 1;
            bind(port).map(drop)
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, BIND_ATTEMPTS);
        assert_eq!(error.to_string(), "Another program, or another copy of TerminalX, is using port 6768. Close it and retry.");
        drop(occupied);
        assert!(
            prepare(PairingConnectionMode::LocalOnly, || bind(port).map(drop))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn the_listen_setting_decides_which_addresses_are_bound() {
        let error = bind_each(&[], 0).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AddrNotAvailable, "relay only opens nothing");
        let message = prepare(PairingConnectionMode::LocalOnly, || bind_each(&[], 0).map(drop)).await.unwrap_err().to_string();
        assert!(message.contains("Relay only") && message.contains("Local network"), "{message}");
        assert!(!prepare(PairingConnectionMode::Automatic, || bind_each(&[], 0).map(drop)).await.unwrap(), "relay pairing goes on without it");

        let bound = bind_each(&[Ipv4Addr::LOCALHOST], 0).unwrap();
        assert_eq!(bound.len(), 1);
        assert_eq!(bound[0].local_addr().unwrap().ip(), Ipv4Addr::LOCALHOST, "the chosen address, not every interface");
        // An address this Mac does not have fails the whole set.
        assert!(bind_each(&[Ipv4Addr::LOCALHOST, Ipv4Addr::new(203, 0, 113, 7)], 0).is_err());
    }

    #[tokio::test]
    async fn permission_errors_are_friendly_and_not_retried() {
        let mut attempts = 0;
        let error = prepare(PairingConnectionMode::LocalOnly, || {
            attempts += 1;
            Err(io::ErrorKind::PermissionDenied.into())
        })
        .await
        .unwrap_err();
        // Windows reports a bind over another listener as access denied, so
        // there it is a taken port and is retried.
        assert_eq!(attempts, if cfg!(windows) { BIND_ATTEMPTS } else { 1 });
        assert_eq!(
            error.to_string(),
            if cfg!(windows) {
                "Another program, or another copy of TerminalX, is using port 6768. Close it and retry."
            } else {
                "TerminalX does not have permission to use port 6768 for LAN pairing."
            }
        );
        assert!(!prepare(PairingConnectionMode::Automatic, || Err(
            io::ErrorKind::PermissionDenied.into()
        ))
        .await
        .unwrap());
    }
}
