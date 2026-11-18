//! The window's side of a machine whose runtime hosts operating computers
//! (PRO-341, `crate::machine_wire`). The window and the runtime never both
//! listen on TCP 6768. While "Let other computers operate this Mac" is on the
//! runtime owns the port, and the window:
//!
//! - closes its own listener and the phones connected to it (they reconnect,
//!   now through the runtime), so the runtime can bind the port;
//! - hands the runtime the bytes of its host key when the runtime has none,
//!   so the machine keeps one fingerprint;
//! - takes phones from a private Unix socket it registers with the runtime
//!   (`runtime.machineHost.phoneRoute`), and serves them exactly as before.
//!
//! When the switch goes off the runtime closes the phones it passed on, and
//! the window binds the port again.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use super::{pairing_websocket_config, ConnectionSignal, PairingConnectionContext, PairingManager};
use crate::local_runtime::desktop::Desktop;
use crate::machine_wire::{self as wire, Forwarded, HostKeyState, Status};
use super::model::PairingTransport;

/// The phone route this window registered for one attachment. Dropping it
/// stops taking phones and removes the socket.
pub(super) struct PhoneRoute {
    lease: String,
    path: PathBuf,
    accept: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for PhoneRoute {
    fn drop(&mut self) {
        self.accept.abort();
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Default)]
pub(super) struct MachineSide {
    /// The runtime's last machine host status; `None` before it said, with
    /// no runtime attached, or from a runtime too old to host.
    status: Option<Status>,
    route: Option<PhoneRoute>,
}

/// The runtime's own relay registration (PRO-368), as the window's relay
/// supervisor follows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum RuntimeRelay {
    /// The runtime does not register this Mac: the window registers itself.
    Off,
    /// The runtime is making its first registration: the window waits a
    /// while ([`super::relay`]'s `RUNTIME_WAIT`) rather than take the host id
    /// from it, which the relay would only close again.
    Connecting,
    /// The window uses this registration for its phones.
    Registered(wire::RelayRegistration),
}

/// What the window does about the runtime's relay registration in `status`.
/// A runtime that lost or was refused its registration (`retrying`) is not
/// waited for: the window registers itself until the runtime's registration
/// retires it.
fn runtime_relay(status: Option<&Status>) -> RuntimeRelay {
    let Some(status) = status.filter(|status| status.enabled) else { return RuntimeRelay::Off };
    match (status.relay_state, &status.relay) {
        (wire::RelayState::Registered, Some(registration)) => RuntimeRelay::Registered(registration.clone()),
        (wire::RelayState::Registered | wire::RelayState::Connecting, _) => RuntimeRelay::Connecting,
        (wire::RelayState::Off | wire::RelayState::SignedOut | wire::RelayState::Retrying | wire::RelayState::Superseded, _) => RuntimeRelay::Off,
    }
}

impl MachineSide {
    pub(super) fn runtime_owns_direct(&self) -> bool {
        self.status.as_ref().is_some_and(Status::runtime_owns_direct)
    }

    fn runtime_relay(&self) -> RuntimeRelay {
        runtime_relay(self.status.as_ref())
    }

    /// Take no more phones from the runtime.
    pub(super) fn stop(&mut self) {
        self.route = None;
    }
}

impl PairingManager {
    /// Whether the runtime holds the direct port, as it last said.
    pub(super) fn runtime_owns_direct(&self) -> bool {
        self.machine.lock().unwrap().runtime_owns_direct()
    }

    /// The runtime's relay registration, as it last said.
    pub(super) fn runtime_relay(&self) -> RuntimeRelay {
        self.machine.lock().unwrap().runtime_relay()
    }

    /// Ask the runtime for its machine host status and follow it. IPC: off
    /// the main thread.
    pub(super) fn reconcile_machine_soon(self: &Arc<Self>) {
        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let Some(runtime) = manager.runtime.lock().unwrap().clone() else { return };
            match runtime.machine_host_status() {
                Ok(status) => manager.follow_machine(&runtime, status),
                Err(error) => log::debug!("machine host status unavailable: {error:#}"),
            }
        });
    }

    /// The runtime's `machine_host_changed` event carries its new status.
    pub(super) fn machine_host_changed(self: &Arc<Self>, payload: &str) {
        let Ok(status) = serde_json::from_str::<Status>(payload) else {
            log::debug!("ignoring a machine host status this build cannot read");
            return;
        };
        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let Some(runtime) = manager.runtime.lock().unwrap().clone() else { return };
            manager.follow_machine(&runtime, Some(status));
        });
    }

    /// Bring the window's listener and phone route in line with `status`.
    fn follow_machine(self: &Arc<Self>, runtime: &Arc<Desktop>, status: Option<Status>) {
        if self.is_stopped() {
            return;
        }
        let owns = status.as_ref().is_some_and(Status::runtime_owns_direct);
        let needs_key = status.as_ref().is_some_and(|status| status.enabled && status.host_key == HostKeyState::Needed);
        let signed_out = status.as_ref().is_some_and(|status| status.enabled && status.relay_state == wire::RelayState::SignedOut);
        let relay = {
            let mut side = self.machine.lock().unwrap();
            let before = side.runtime_relay();
            side.status = status;
            let after = side.runtime_relay();
            (before != after).then_some(after)
        };
        if let Some(relay) = &relay {
            // The window's relay supervisor picks again: its own
            // registration, or the runtime's.
            self.relay_retry.notify_one();
            log::info!("the runtime's relay registration is now {}", match relay {
                RuntimeRelay::Off => "off",
                RuntimeRelay::Connecting => "connecting",
                RuntimeRelay::Registered(_) => "registered",
            });
        }
        // The runtime found no session to register with while this window
        // is signed in: give it this one (an app updated with the switch on).
        if signed_out && self.account.current_scope().is_some() {
            self.account.sync_runtime_copy();
        }
        // The runtime passes phones' relay connections to the phone route
        // while it is registered, whoever holds the direct port.
        let relayed = matches!(self.runtime_relay(), RuntimeRelay::Registered(_) | RuntimeRelay::Connecting);
        if relayed {
            if let Err(error) = self.ensure_phone_route(runtime, false) {
                log::warn!("could not take phones from the runtime's relay registration: {error:#}");
            }
        }
        if owns {
            if needs_key {
                if let Err(error) = self.adopt_key(runtime) {
                    log::warn!("could not give the runtime this Mac's host key: {error:#}");
                }
            }
            self.release_direct_port();
            if self.inner.lock().unwrap().direct_wanted {
                if let Err(error) = self.ensure_phone_route(runtime, true) {
                    log::warn!("could not take phones from the runtime: {error:#}");
                }
            }
        } else {
            // A route the relay still uses stays; direct phones come here again.
            let route = if relayed { None } else { self.machine.lock().unwrap().route.take() };
            {
                let mut inner = self.inner.lock().unwrap();
                if inner.direct_via_runtime {
                    inner.direct_listener_started = false;
                    inner.direct_via_runtime = false;
                }
            }
            drop(route);
            if self.inner.lock().unwrap().direct_wanted {
                // The runtime's last connections may hold the port a while.
                if self.ensure_direct_listener().is_err() {
                    self.retry_direct_listener();
                }
            }
        }
        self.emit();
    }

    /// The runtime keeps a copy of the phone pairing key (docs/MACHINES.md,
    /// "How PRO-341 builds it"), so a computer and a phone see one fingerprint.
    fn adopt_key(&self, runtime: &Desktop) -> Result<()> {
        let keypair = self.host_key(true)?;
        let secret = zeroize::Zeroizing::new(STANDARD.encode(keypair.secret()));
        runtime.machine_host(wire::ADOPT_KEY, json!({ "secretB64": *secret }))?;
        log::info!("the runtime now answers with this Mac's host key");
        Ok(())
    }

    /// Direct connections while the runtime owns the port: its phone route.
    pub(super) fn take_phones_from_runtime(self: &Arc<Self>) -> std::io::Result<()> {
        let runtime = self.runtime.lock().unwrap().clone().ok_or_else(|| std::io::Error::other("no runtime is attached"))?;
        self.ensure_phone_route(&runtime, true).map_err(|error| std::io::Error::other(format!("{error:#}")))
    }

    /// Close the window's own listener on the port and the phones on it.
    fn release_direct_port(&self) {
        let accept = {
            let mut inner = self.inner.lock().unwrap();
            if inner.direct_via_runtime {
                return;
            }
            inner.direct_listener_started = false;
            inner.direct_accept.take()
        };
        let Some(accept) = accept else { return };
        accept.abort();
        // Each open connection holds the port; the phones reconnect through
        // the runtime, which passes them back here.
        for connections in self.connections.lock().unwrap().values() {
            for connection in connections.iter().filter(|connection| connection.transport == PairingTransport::Direct) {
                let _ = connection.signal.send(ConnectionSignal::Cancel);
            }
        }
        log::info!("the runtime takes this Mac's direct connections now");
    }

    /// Listen on a private socket in the runtime's directory and register it,
    /// once per attachment. `direct`: the runtime holds the direct port too,
    /// so the window's direct phones come this way (else only relay ones).
    #[cfg(unix)]
    fn ensure_phone_route(self: &Arc<Self>, runtime: &Desktop, direct: bool) -> Result<()> {
        let attachment = runtime.attachment()?;
        if self.machine.lock().unwrap().route.as_ref().is_some_and(|route| route.lease == attachment.lease) {
            if direct {
                let mut inner = self.inner.lock().unwrap();
                inner.direct_listener_started = true;
                inner.direct_via_runtime = true;
            }
            return Ok(());
        }
        let run = crate::store::root()?.join("run");
        let path = run.join(format!("phones-{}.sock", &Uuid::new_v4().simple().to_string()[..12]));
        let listener = std::os::unix::net::UnixListener::bind(&path).with_context(|| format!("listen on {}", path.display()))?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        listener.set_nonblocking(true)?;
        let manager = self.clone();
        let accept = tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::UnixListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    log::warn!("phone route unavailable: {error}");
                    return;
                }
            };
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let manager = manager.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = manager.routed_phone(stream).await {
                        log::debug!("phone from the runtime ended: {error:#}");
                    }
                });
            }
        });
        let route = PhoneRoute { lease: attachment.lease.clone(), path: path.clone(), accept };
        runtime.machine_host(wire::PHONE_ROUTE, json!({ "socket": path }))?;
        self.machine.lock().unwrap().route = Some(route);
        if direct {
            let mut inner = self.inner.lock().unwrap();
            inner.direct_listener_started = true;
            inner.direct_via_runtime = true;
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn ensure_phone_route(self: &Arc<Self>, _runtime: &Desktop, _direct: bool) -> Result<()> {
        bail!("phone routes need Unix sockets")
    }

    /// One phone the runtime passed on: its header line, then the phone.
    #[cfg(unix)]
    async fn routed_phone(self: Arc<Self>, mut stream: tokio::net::UnixStream) -> Result<()> {
        let header = read_header(&mut stream).await?;
        match wire::decode_header(&header)? {
            // The phone's own bytes follow, from its HTTP upgrade request.
            Forwarded::Direct { .. } => {
                let socket =
                    tokio_tungstenite::accept_async_with_config(crate::data_privacy::NetworkIo::new(stream), Some(pairing_websocket_config())).await?;
                let context = PairingConnectionContext::Direct { direct_auth_id: Uuid::new_v4().simple().to_string() };
                self.handle_e2ee_socket(socket, context, None, None).await
            }
            // The window opens the relay data leg itself.
            Forwarded::Relay { cell_url, relay_host_id, generation, connection } => {
                let connection = super::relay::ConnectionOpen::forwarded(connection)?;
                let keypair = self.host_key(false)?;
                until_route_closes(&mut stream, self.handle_relay_connection(cell_url, relay_host_id, generation, keypair, connection)).await
            }
        }
    }
}

#[cfg(unix)]
async fn until_route_closes<T>(stream: &mut tokio::net::UnixStream, serving: impl std::future::Future<Output = Result<T>>) -> Result<()> {
    let mut byte = [0; 1];
    tokio::select! {
        biased;
        result = stream.read(&mut byte) => { result?; Ok(()) },
        result = serving => { result?; Ok(()) },
    }
}

/// Read the header line byte by byte, so nothing after it is consumed.
async fn read_header<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>> {
    let mut line = Vec::with_capacity(256);
    loop {
        let byte = stream.read_u8().await.context("the runtime closed before the phone route header")?;
        line.push(byte);
        if byte == b'\n' {
            return Ok(line);
        }
        if line.len() >= wire::MAX_HEADER_BYTES {
            bail!("phone route header is over {} bytes", wire::MAX_HEADER_BYTES);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[cfg(unix)]
    #[tokio::test]
    async fn relay_route_closure_cancels_the_window_connection() {
        let (runtime, mut window) = tokio::net::UnixStream::pair().unwrap();
        let (dropped, observed) = tokio::sync::oneshot::channel::<()>();
        let (started, ready) = tokio::sync::oneshot::channel();
        let serving = async move {
            let _guard = dropped;
            let _ = started.send(());
            std::future::pending::<Result<()>>().await
        };
        let task = tokio::spawn(async move { until_route_closes(&mut window, serving).await });
        ready.await.unwrap();
        drop(runtime);
        tokio::time::timeout(std::time::Duration::from_secs(5), task).await.unwrap().unwrap().unwrap();
        assert!(observed.await.is_err(), "the relay serving future must be dropped");
    }

    #[tokio::test]
    async fn the_header_is_read_without_taking_the_phones_bytes() {
        let (mut runtime, mut window) = tokio::io::duplex(1024);
        let header = wire::encode_header(&Forwarded::Direct { peer: Some("10.0.0.2:5000".into()) }).unwrap();
        runtime.write_all(&header).await.unwrap();
        runtime.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        drop(runtime);
        let read = read_header(&mut window).await.unwrap();
        assert_eq!(read, header);
        let mut rest = Vec::new();
        window.read_to_end(&mut rest).await.unwrap();
        assert_eq!(rest, b"GET / HTTP/1.1\r\n\r\n");
    }

    #[tokio::test]
    async fn an_endless_header_is_refused() {
        let (mut runtime, mut window) = tokio::io::duplex(64 * 1024);
        runtime.write_all(&vec![b'x'; wire::MAX_HEADER_BYTES + 1]).await.unwrap();
        assert!(read_header(&mut window).await.is_err());
    }

    #[test]
    fn only_an_enabled_runtime_owns_the_port() {
        let mut side = MachineSide::default();
        assert!(!side.runtime_owns_direct(), "no runtime said anything");
        let status = |enabled| Status {
            enabled,
            host_key: HostKeyState::Ready,
            machine_id: None,
            listening: None,
            takes_port: enabled,
            phone_route: false,
            computers: vec![],
            error: None,
            pending: None,
            code: None,
            paused_until: None,
            phones: Default::default(),
            relay_state: wire::RelayState::Off,
            relay: None,
        };
        side.status = Some(status(false));
        assert!(!side.runtime_owns_direct());
        side.status = Some(status(true));
        assert!(side.runtime_owns_direct(), "on, even before its listener is bound");
        side.status = Some(Status { takes_port: false, host_key: HostKeyState::Error, ..status(true) });
        assert!(!side.runtime_owns_direct(), "on, but it cannot listen: the window keeps the port");
    }

    /// PRO-368: the window uses the runtime's relay registration while it is
    /// registered, waits for a first one, and registers itself otherwise.
    #[test]
    fn the_window_follows_the_runtimes_relay_registration() {
        let registration = wire::RelayRegistration {
            relay_host_id: "host".into(),
            director_url: "https://director".into(),
            cell_url: "wss://cell".into(),
            assignment_epoch: 3,
            generation: 2,
            runtime_generation: 7,
        };
        let status = |enabled, relay_state, relay: Option<wire::RelayRegistration>| Status {
            enabled,
            host_key: HostKeyState::Ready,
            machine_id: None,
            listening: None,
            takes_port: enabled,
            phone_route: false,
            computers: vec![],
            error: None,
            pending: None,
            code: None,
            paused_until: None,
            phones: Default::default(),
            relay_state,
            relay,
        };
        assert_eq!(runtime_relay(None), RuntimeRelay::Off, "no runtime said anything");
        assert_eq!(
            runtime_relay(Some(&status(true, wire::RelayState::Registered, Some(registration.clone())))),
            RuntimeRelay::Registered(registration.clone())
        );
        assert_eq!(runtime_relay(Some(&status(true, wire::RelayState::Connecting, None))), RuntimeRelay::Connecting);
        // Registered, but its registration is not in the status yet.
        assert_eq!(runtime_relay(Some(&status(true, wire::RelayState::Registered, None))), RuntimeRelay::Connecting);
        for state in [wire::RelayState::Off, wire::RelayState::SignedOut, wire::RelayState::Retrying, wire::RelayState::Superseded] {
            assert_eq!(runtime_relay(Some(&status(true, state, None))), RuntimeRelay::Off, "{state:?}: the window registers itself");
        }
        // Switched off: whatever it last said about the relay.
        assert_eq!(runtime_relay(Some(&status(false, wire::RelayState::Registered, Some(registration)))), RuntimeRelay::Off);
    }
}
