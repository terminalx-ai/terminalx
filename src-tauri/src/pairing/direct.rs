use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use tokio::net::{TcpListener, TcpSocket};

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
    // so an advertised address could still reach the other program.
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
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && attempt < BIND_ATTEMPTS => {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(error) => {
                log::warn!("LAN pairing listener failed: {error}");
                let message = match error.kind() {
                    io::ErrorKind::AddrInUse => format!(
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
        assert_eq!(attempts, 1);
        assert_eq!(
            error.to_string(),
            "TerminalX does not have permission to use port 6768 for LAN pairing."
        );
        assert!(!prepare(PairingConnectionMode::Automatic, || Err(
            io::ErrorKind::PermissionDenied.into()
        ))
        .await
        .unwrap());
    }
}
