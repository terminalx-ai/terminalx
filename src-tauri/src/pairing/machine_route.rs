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

impl MachineSide {
    pub(super) fn runtime_owns_direct(&self) -> bool {
        self.status.as_ref().is_some_and(Status::runtime_owns_direct)
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
        self.machine.lock().unwrap().status = status;
        if owns {
            if needs_key {
                if let Err(error) = self.adopt_key(runtime) {
                    log::warn!("could not give the runtime this Mac's host key: {error:#}");
                }
            }
            self.release_direct_port();
            if self.inner.lock().unwrap().direct_wanted {
                if let Err(error) = self.ensure_phone_route(runtime) {
                    log::warn!("could not take phones from the runtime: {error:#}");
                }
            }
        } else {
            let route = self.machine.lock().unwrap().route.take();
            if route.is_some() {
                let mut inner = self.inner.lock().unwrap();
                inner.direct_listener_started = false;
                inner.direct_via_runtime = false;
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
        self.ensure_phone_route(&runtime).map_err(|error| std::io::Error::other(format!("{error:#}")))
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
    /// once per attachment.
    #[cfg(unix)]
    fn ensure_phone_route(self: &Arc<Self>, runtime: &Desktop) -> Result<()> {
        let attachment = runtime.attachment()?;
        if self.machine.lock().unwrap().route.as_ref().is_some_and(|route| route.lease == attachment.lease) {
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
        let mut inner = self.inner.lock().unwrap();
        inner.direct_listener_started = true;
        inner.direct_via_runtime = true;
        Ok(())
    }

    #[cfg(not(unix))]
    fn ensure_phone_route(self: &Arc<Self>, _runtime: &Desktop) -> Result<()> {
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
                drop(stream);
                let connection = super::relay::ConnectionOpen::forwarded(connection)?;
                let keypair = self.host_key(false)?;
                self.handle_relay_connection(cell_url, relay_host_id, generation, keypair, connection).await
            }
        }
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
        };
        side.status = Some(status(false));
        assert!(!side.runtime_owns_direct());
        side.status = Some(status(true));
        assert!(side.runtime_owns_direct(), "on, even before its listener is bound");
        side.status = Some(Status { takes_port: false, host_key: HostKeyState::Error, ..status(true) });
        assert!(!side.runtime_owns_direct(), "on, but it cannot listen: the window keeps the port");
    }
}
