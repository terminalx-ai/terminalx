//! Relay diagnostics are an allowlist, never formatted error chains or wire data.
//! A small atomic snapshot survives GUI launches whose stderr is /dev/null.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::cloud::CloudHttpError;

const MAX_RECORDS: usize = 128;
const MAX_BYTES: u64 = 64 * 1024;
pub(super) const FILE_NAME: &str = "relay-diagnostics.json";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Error, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[error("relay stage {self:?}")]
pub(super) enum Stage {
    LocalIdentity,
    Authorization,
    Assignment,
    ControlConnect,
    HostProof,
    ControlSession,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Error, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[error("relay category {self:?}")]
pub(super) enum Category {
    ServiceUnavailable,
    Authentication,
    AccessDenied,
    Entitlement,
    RateLimited,
    Network,
    Timeout,
    Protocol,
    LocalStorage,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Failure {
    pub stage: Stage,
    pub category: Category,
    pub http_status: Option<u16>,
}

impl Failure {
    pub fn from_error(error: &anyhow::Error) -> Self {
        use tokio_tungstenite::tungstenite::Error as WsError;
        let stage = error
            .downcast_ref::<Stage>()
            .copied()
            .unwrap_or(Stage::ControlSession);
        let http_status = error
            .downcast_ref::<CloudHttpError>()
            .map(|error| error.0)
            .or_else(|| match error.downcast_ref::<WsError>() {
                Some(WsError::Http(response)) => Some(response.status().as_u16()),
                _ => None,
            });
        let category = if let Some(status) = http_status {
            match status {
                500..=599 => Category::ServiceUnavailable,
                401 => Category::Authentication,
                403 => Category::AccessDenied,
                429 => Category::RateLimited,
                _ => Category::Protocol,
            }
        } else if let Some(category) = error.downcast_ref::<Category>() {
            *category
        } else if stage == Stage::LocalIdentity {
            Category::LocalStorage
        } else if error.chain().any(|cause| {
            cause.is::<tokio::time::error::Elapsed>()
                || cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::TimedOut)
        }) {
            Category::Timeout
        } else if error.downcast_ref::<ureq::Transport>().is_some()
            || matches!(
                error.downcast_ref::<WsError>(),
                Some(
                    WsError::Io(_)
                        | WsError::Tls(_)
                        | WsError::ConnectionClosed
                        | WsError::AlreadyClosed
                )
            )
        {
            Category::Network
        } else if stage == Stage::HostProof
            || error.downcast_ref::<serde_json::Error>().is_some()
            || matches!(
                error.downcast_ref::<WsError>(),
                Some(WsError::Protocol(_) | WsError::Capacity(_) | WsError::Utf8(_))
            )
        {
            Category::Protocol
        } else {
            Category::Unknown
        };
        Self {
            stage,
            category,
            http_status,
        }
    }

    pub fn message(self) -> &'static str {
        match self.category {
            Category::ServiceUnavailable if self.stage == Stage::Authorization =>
                "The account service cannot authorize Relay right now. Retrying automatically. You can use LAN meanwhile.",
            Category::ServiceUnavailable =>
                "TerminalX Relay service is temporarily unavailable. Retrying automatically. You can use LAN meanwhile.",
            Category::Authentication =>
                "Relay authorization was rejected. Retrying automatically. If this continues, check your sign-in in Settings → Account.",
            Category::AccessDenied =>
                "Relay access was denied. Check your account's Relay access in Settings → Account. You can use LAN meanwhile.",
            Category::Entitlement =>
                "Relay is not enabled for this account. You can use LAN to pair.",
            Category::RateLimited =>
                "Relay is receiving too many requests. Retrying automatically. You can use LAN meanwhile.",
            Category::Network =>
                "Cannot reach Relay. Check your connection, VPN or firewall. Retrying automatically.",
            Category::Timeout =>
                "The Relay connection timed out. Retrying automatically. You can use LAN meanwhile.",
            Category::Protocol =>
                "Relay returned an unexpected response. Retrying automatically. If this continues, check for a TerminalX update.",
            Category::LocalStorage =>
                "TerminalX could not access its local Relay identity. Check Keychain access, then retry.",
            Category::Unknown =>
                "Relay connection ended unexpectedly. Retrying automatically. You can use LAN meanwhile.",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Event {
    Started,
    Failed,
    Connected,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    timestamp_ms: i64,
    event: Event,
    attempt: u32,
    #[serde(default)]
    retry_count: u32,
    failure: Option<Failure>,
}

#[derive(Default)]
pub(super) struct DiagnosticLog {
    path: Option<PathBuf>,
    records: VecDeque<Record>,
}

impl DiagnosticLog {
    pub fn configure(&mut self, directory: PathBuf) -> std::io::Result<()> {
        std::fs::create_dir_all(&directory)?;
        let path = directory.join(FILE_NAME);
        // Bound reads as well as writes, including files left by other versions.
        if let Ok(file) = std::fs::File::open(&path) {
            let mut bytes = Vec::new();
            if file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_ok()
                && bytes.len() <= MAX_BYTES as usize
            {
                self.records = serde_json::from_slice(&bytes).unwrap_or_default();
            }
        }
        self.path = Some(path);
        self.record(Event::Started, 0, None)
    }

    pub fn record(
        &mut self,
        event: Event,
        attempt: u32,
        failure: Option<Failure>,
    ) -> std::io::Result<()> {
        self.records.push_back(Record {
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event,
            attempt,
            retry_count: attempt.saturating_sub(1),
            failure,
        });
        while self.records.len() > MAX_RECORDS {
            self.records.pop_front();
        }
        let Some(path) = &self.path else {
            return Ok(());
        };
        let bytes = serde_json::to_vec(&self.records)?;
        if bytes.len() > MAX_BYTES as usize {
            return Err(std::io::Error::other("relay diagnostic limit exceeded"));
        }
        // NamedTempFile creates mode 0600 on Unix. Atomic replacement preserves
        // the last complete snapshot on a failed write, without following a symlink.
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(&bytes)?;
        file.persist(path).map_err(|error| error.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_auth_and_access_errors_stay_distinct_through_context() {
        for (status, expected) in [
            (502, Category::ServiceUnavailable),
            (503, Category::ServiceUnavailable),
            (401, Category::Authentication),
            (403, Category::AccessDenied),
            (429, Category::RateLimited),
            (400, Category::Protocol),
        ] {
            let error = anyhow::Error::new(CloudHttpError(status))
                .context("sensitive-body token=secret")
                .context(Stage::Assignment);
            let failure = Failure::from_error(&error);
            assert_eq!(failure.category, expected);
            assert_eq!(failure.http_status, Some(status));
            assert_eq!(failure.stage, Stage::Assignment);
            let output = serde_json::to_string(&failure).unwrap();
            assert!(!output.contains("secret"));
            assert!(!failure.message().contains("secret"));
        }
    }

    #[test]
    fn websocket_errors_never_retain_headers_bodies_or_urls() {
        let response = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(502)
            .header("set-cookie", "secret-cookie")
            .body(Some(b"secret-response".to_vec()))
            .unwrap();
        let error = anyhow::Error::new(tokio_tungstenite::tungstenite::Error::Http(Box::new(
            response,
        )))
        .context("wss://private.example/host-secret?token=secret-token")
        .context(Stage::ControlConnect);
        let failure = Failure::from_error(&error);
        assert_eq!(failure.category, Category::ServiceUnavailable);
        assert_eq!(failure.http_status, Some(502));
        let directory = tempfile::tempdir().unwrap();
        let mut log = DiagnosticLog::default();
        log.configure(directory.path().to_owned()).unwrap();
        log.record(Event::Failed, 12, Some(failure)).unwrap();
        let bytes = std::fs::read_to_string(directory.path().join(FILE_NAME)).unwrap();
        for sensitive in ["secret", "private.example", "cookie", "wss://"] {
            assert!(!bytes.contains(sensitive));
        }
        assert!(bytes.contains("service-unavailable"));
        assert!(bytes.contains("\"attempt\":12"));
    }

    #[test]
    fn diagnostics_survive_relaunch_and_remain_bounded_and_private() {
        let directory = tempfile::tempdir().unwrap();
        let mut log = DiagnosticLog::default();
        log.configure(directory.path().to_owned()).unwrap();
        for attempt in 1..=200 {
            log.record(
                Event::Failed,
                attempt,
                Some(Failure {
                    stage: Stage::Assignment,
                    category: Category::ServiceUnavailable,
                    http_status: Some(502),
                }),
            )
            .unwrap();
        }
        let mut relaunched = DiagnosticLog::default();
        relaunched.configure(directory.path().to_owned()).unwrap();
        relaunched.record(Event::Connected, 201, None).unwrap();
        let path = directory.path().join(FILE_NAME);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() <= MAX_BYTES as usize);
        let records: Vec<Record> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(records.len(), MAX_RECORDS);
        assert_eq!(records[0].attempt, 75);
        assert!(matches!(records.last().unwrap().event, Event::Connected));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn corrupt_oversized_and_non_allowlisted_files_are_replaced() {
        let directory = tempfile::tempdir().unwrap();
        for bytes in [
            b"invalid secret".to_vec(),
            vec![b'x'; MAX_BYTES as usize + 1],
            br#"[{"timestampMs":0,"event":"failed","attempt":1,"failure":null,"token":"secret"}]"#
                .to_vec(),
        ] {
            std::fs::write(directory.path().join(FILE_NAME), bytes).unwrap();
            let mut log = DiagnosticLog::default();
            log.configure(directory.path().to_owned()).unwrap();
            assert_eq!(log.records.len(), 1);
            assert!(!std::fs::read_to_string(directory.path().join(FILE_NAME))
                .unwrap()
                .contains("secret"));
        }
    }
    #[test]
    fn network_timeout_and_unknown_errors_use_no_text_matching() {
        let timeout = anyhow::Error::new(tokio_tungstenite::tungstenite::Error::Io(
            std::io::Error::new(std::io::ErrorKind::TimedOut, "secret local address"),
        ))
        .context(Stage::ControlConnect);
        assert_eq!(Failure::from_error(&timeout).category, Category::Timeout);
        let network = anyhow::Error::new(tokio_tungstenite::tungstenite::Error::Io(
            std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "secret local address",
            ),
        ))
        .context(Stage::ControlConnect);
        assert_eq!(Failure::from_error(&network).category, Category::Network);
        let unknown = anyhow::anyhow!("HTTP 502 token=secret email=fixture@example.invalid")
            .context(Stage::Assignment);
        let failure = Failure::from_error(&unknown);
        assert_eq!(failure.category, Category::Unknown);
        assert_eq!(failure.http_status, None);
        assert!(!failure.message().contains("secret"));
    }

    #[test]
    fn gui_launch_persists_with_stdout_and_stderr_discarded() {
        let directory = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "pairing::diagnostics::tests::gui_launch_child",
                "--nocapture",
            ])
            .env("TERMINALX_RELAY_TEST_LOG_DIR", directory.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let bytes = std::fs::read_to_string(directory.path().join(FILE_NAME)).unwrap();
        assert!(bytes.contains("service-unavailable"));
        assert!(bytes.contains("\"httpStatus\":502"));
        assert!(bytes.contains("\"retryCount\":11"));
        assert!(!bytes.contains("secret"));
    }

    #[test]
    fn gui_launch_child() {
        let Some(directory) = std::env::var_os("TERMINALX_RELAY_TEST_LOG_DIR") else {
            return;
        };
        let manager = super::super::PairingManager::new(std::sync::Arc::new(
            crate::account::AccountManager::default(),
        ));
        manager
            .diagnostics
            .lock()
            .unwrap()
            .configure(directory.into())
            .unwrap();
        let error = anyhow::Error::new(CloudHttpError(502))
            .context("secret body")
            .context(Stage::Assignment);
        manager.record_relay_diagnostic(Event::Failed, 12, Some(Failure::from_error(&error)));
    }

    #[test]
    fn failed_file_writes_do_not_stop_status_updates() {
        let directory = tempfile::tempdir().unwrap();
        let manager = super::super::PairingManager::new(std::sync::Arc::new(
            crate::account::AccountManager::default(),
        ));
        manager
            .diagnostics
            .lock()
            .unwrap()
            .configure(directory.path().to_owned())
            .unwrap();
        // Make the destination unwritable even when the test runs as root.
        std::fs::remove_file(directory.path().join(FILE_NAME)).unwrap();
        std::fs::create_dir(directory.path().join(FILE_NAME)).unwrap();
        let failure = Failure {
            stage: Stage::Assignment,
            category: Category::ServiceUnavailable,
            http_status: Some(502),
        };
        manager.record_relay_diagnostic(Event::Failed, 1, Some(failure));
        manager.set_relay_unavailable(failure.message(), 1);
        assert_eq!(
            manager
                .inner
                .lock()
                .unwrap()
                .relay_status
                .message
                .as_deref(),
            Some(failure.message())
        );
    }
}
