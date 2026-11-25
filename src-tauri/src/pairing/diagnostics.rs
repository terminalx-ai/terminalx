//! Relay diagnostics are an allowlist, never formatted error chains or wire data.
//! A small atomic snapshot survives GUI launches whose stderr is /dev/null.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::cloud::CloudHttpError;

const MAX_RECORDS: usize = 128;
/// The longest run of records that folds into the same run before it
/// (#1579): a loop of connect, fail, connect, fail keeps two records, not
/// the buffer, and the records from before it began stay.
const FOLD_WINDOW: usize = 4;
/// A phone retrying in a loop must not push the control channel's history out.
const MAX_PHONE_RECORDS: usize = MAX_RECORDS / 2;
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
    /// The account service's heartbeat, grant and revocation requests for
    /// this host, made beside a connected control channel.
    HostBinding,
    /// A phone's relay connection: the host data leg to the cell.
    PhoneAttach,
    /// The phone's E2EE handshake and device login, through the cell.
    PhoneHandshake,
    /// After the phone logged in.
    PhoneSession,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Error, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[error("relay category {self:?}")]
pub(super) enum Category {
    ServiceUnavailable,
    ServiceRestart,
    AssignmentChanged,
    RemoteClosed,
    Authentication,
    AccessDenied,
    Entitlement,
    RateLimited,
    Network,
    Timeout,
    Protocol,
    LocalStorage,
    /// The control socket's source address left every interface.
    NetworkChanged,
    /// The Mac slept: the cell has dropped a control channel that missed its pings.
    Woke,
    /// The local runtime refused or did not answer a paired-device call.
    LocalRuntime,
    /// The phone did not read its messages as fast as the Mac sent them,
    /// and its outbound queue filled (#1282).
    FellBehind,
    /// The Mac closed the phone's stream: its terminal output failed or the
    /// owner let the connection go.
    HostClosed,
    /// The account binding changed under the connection.
    AccountChanged,
    /// The phone sent more requests than the Mac holds unanswered.
    TooManyRequests,
    /// The relay accepted this Mac's registration, then closed it with 4401,
    /// more than once in a row (#1579).
    Refused,
    /// This window's own registration was retired by the runtime's (4101).
    /// Expected, not a failure: the window uses the runtime's from then on.
    RuntimeTookOver,
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
        } else if let Some(fault) = error.downcast_ref::<crate::phone::Fault>() {
            use crate::phone::Fault;
            match fault {
                Fault::FellBehind => Category::FellBehind,
                Fault::Closed => Category::HostClosed,
                Fault::Changed => Category::AccountChanged,
                Fault::Unreadable => Category::Protocol,
                Fault::TooManyRequests => Category::TooManyRequests,
            }
        } else if error.downcast_ref::<crate::phone::RuntimeUnanswered>().is_some() {
            Category::LocalRuntime
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
        crate::platform_profile::localize_static(match self.category {
            Category::ServiceUnavailable if self.stage == Stage::Authorization =>
                "The account service cannot authorize Relay right now. Retrying automatically. You can use LAN meanwhile.",
            Category::ServiceUnavailable =>
                "TerminalX Relay service is temporarily unavailable. Retrying automatically. You can use LAN meanwhile.",
            Category::ServiceRestart =>
                "The Relay service is restarting or replacing this connection. Reconnecting automatically.",
            Category::AssignmentChanged =>
                "This Mac's Relay assignment changed. Reconnecting automatically.",
            Category::RemoteClosed =>
                "The Relay service closed the connection. Reconnecting automatically.",
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
            Category::NetworkChanged =>
                "This Mac's network changed. Reconnecting to Relay automatically.",
            Category::Woke =>
                "This Mac woke from sleep. Reconnecting to Relay automatically.",
            Category::LocalRuntime =>
                "TerminalX's local runtime did not answer. Retrying automatically. If this continues, quit and reopen TerminalX.",
            Category::FellBehind =>
                "A phone fell behind this Mac's updates and was reconnected.",
            Category::HostClosed =>
                "This Mac closed a phone's connection. It reconnects automatically.",
            Category::AccountChanged =>
                "This Mac's account changed while a phone was connected.",
            Category::TooManyRequests =>
                "A phone sent more requests than this Mac answers at once and was reconnected.",
            Category::Refused =>
                "Relay keeps closing this Mac's connection right after it connects. TerminalX now retries every few minutes. If this continues, check for a TerminalX update. You can use LAN meanwhile.",
            Category::RuntimeTookOver =>
                "TerminalX's local runtime took over this Mac's Relay connection.",
            Category::Unknown =>
                "Relay connection ended unexpectedly. Retrying automatically. You can use LAN meanwhile.",
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Event {
    Started,
    Failed,
    Connected,
    RetryRequested,
    /// A host-binding request succeeded after `attempt` failed rounds.
    Recovered,
    /// The cell asked for a host data leg (`conn-open`): a phone is connecting.
    PhoneRequested,
    PhoneAttached,
    PhoneAuthenticated,
    /// A phone's session ended without a fault; `ended` says how (#1282).
    /// Earlier versions wrote it as `phone-closed` whatever ended it.
    #[serde(alias = "phone-closed")]
    PhoneEnded,
    PhoneFailed,
}

impl Event {
    fn is_phone(self) -> bool {
        matches!(
            self,
            Self::PhoneRequested
                | Self::PhoneAttached
                | Self::PhoneAuthenticated
                | Self::PhoneEnded
                | Self::PhoneFailed
        )
    }
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
    /// How a phone's session ended without a fault (#1282).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended: Option<crate::phone::EndReason>,
    /// The code of the close frame that ended it, the phone's or the relay's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    close_code: Option<u16>,
    /// The relay's reason code with that close, as
    /// `crate::remote::protocol::close_reason` keeps it: never free text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    close_reason: Option<String>,
    /// How many more times the same record happened after this one, the
    /// last at `last_timestamp_ms` with the attempt in `attempt`.
    #[serde(default, skip_serializing_if = "is_zero")]
    repeats: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_timestamp_ms: Option<i64>,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

impl Record {
    /// Whether `other` is the same thing happening again, whatever its attempt.
    fn repeated_by(&self, other: &Record) -> bool {
        self.event == other.event
            && self.failure == other.failure
            && self.ended == other.ended
            && self.close_code == other.close_code
            && self.close_reason == other.close_reason
    }
}

/// The close of a relay control socket, for [`DiagnosticLog::record_close`].
/// The window's own control closes carry it as an error's context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Close {
    pub code: u16,
    pub reason: Option<String>,
}

impl std::fmt::Display for Close {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "relay control closed with {}", self.code)?;
        if let Some(reason) = &self.reason {
            write!(f, " ({reason})")?;
        }
        Ok(())
    }
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
        self.record_end(event, attempt, failure, None)
    }

    /// `record`, with how a phone's session ended.
    pub fn record_end(
        &mut self,
        event: Event,
        attempt: u32,
        failure: Option<Failure>,
        ended: Option<crate::phone::Ended>,
    ) -> std::io::Result<()> {
        self.push(Record {
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event,
            attempt,
            retry_count: attempt.saturating_sub(1),
            failure,
            ended: ended.map(|ended| ended.reason),
            close_code: ended.and_then(|ended| ended.close_code),
            close_reason: None,
            repeats: 0,
            last_timestamp_ms: None,
        })
    }

    /// `record`, with the close that ended a relay control socket (#1579).
    pub fn record_close(
        &mut self,
        event: Event,
        attempt: u32,
        failure: Option<Failure>,
        close: Close,
    ) -> std::io::Result<()> {
        self.push(Record {
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event,
            attempt,
            retry_count: attempt.saturating_sub(1),
            failure,
            ended: None,
            close_code: Some(close.code),
            close_reason: close.reason.as_deref().and_then(crate::remote::protocol::close_reason),
            repeats: 0,
            last_timestamp_ms: None,
        })
    }

    fn push(&mut self, record: Record) -> std::io::Result<()> {
        let event = record.event;
        self.records.push_back(record);
        if self.fold() {
            return self.persist();
        }
        if event.is_phone()
            && self.records.iter().filter(|record| record.event.is_phone()).count()
                > MAX_PHONE_RECORDS
        {
            if let Some(oldest) = self.records.iter().position(|record| record.event.is_phone()) {
                self.records.remove(oldest);
            }
        }
        while self.records.len() > MAX_RECORDS {
            self.records.pop_front();
        }
        self.persist()
    }

    /// When the last `n` records (`n` up to [`FOLD_WINDOW`]) repeat the `n`
    /// before them, they become repeats of those: a loop keeps one record of
    /// each step, however long it runs. A single retry is not a loop and
    /// keeps its order.
    fn fold(&mut self) -> bool {
        let len = self.records.len();
        let Some(cycle) = (1..=FOLD_WINDOW).filter(|cycle| 2 * cycle <= len).find(|&cycle| {
            (0..cycle).all(|step| self.records[len - 2 * cycle + step].repeated_by(&self.records[len - cycle + step]))
        }) else {
            return false;
        };
        let repeated: Vec<Record> = self.records.drain(len - cycle..).collect();
        for (earlier, again) in self.records.iter_mut().skip(len - 2 * cycle).zip(repeated) {
            earlier.repeats = earlier.repeats.saturating_add(1 + again.repeats);
            earlier.last_timestamp_ms = Some(again.last_timestamp_ms.unwrap_or(again.timestamp_ms));
            earlier.attempt = again.attempt;
            earlier.retry_count = again.retry_count;
        }
        true
    }

    fn persist(&self) -> std::io::Result<()> {
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
        // Windows refuses to replace a file while anything has it open, even
        // for a moment to read it: try again briefly before calling it failed.
        let mut refused = 0;
        loop {
            match file.persist(path) {
                Ok(_) => return Ok(()),
                Err(error) if cfg!(windows) && error.error.kind() == std::io::ErrorKind::PermissionDenied && refused < 20 => {
                    refused += 1;
                    file = error.file;
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => return Err(error.error),
            }
        }
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
        // Five statuses in turn: none repeats within the fold window.
        for attempt in 1..=200 {
            log.record(
                Event::Failed,
                attempt,
                Some(Failure {
                    stage: Stage::Assignment,
                    category: Category::ServiceUnavailable,
                    http_status: Some(500 + (attempt % 5) as u16),
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
    fn a_phone_in_a_reconnect_loop_cannot_push_out_the_control_history() {
        let directory = tempfile::tempdir().unwrap();
        let mut log = DiagnosticLog::default();
        log.configure(directory.path().to_owned()).unwrap();
        // Distinct records throughout, so none folds into an earlier one.
        for attempt in 1..=10 {
            let control = Failure {
                stage: Stage::ControlSession,
                category: Category::ServiceUnavailable,
                http_status: Some(500 + attempt as u16),
            };
            log.record(Event::Failed, attempt, Some(control)).unwrap();
        }
        for round in 0..500u16 {
            let phone = Failure {
                stage: Stage::PhoneHandshake,
                category: Category::Authentication,
                http_status: Some(400 + round % 5),
            };
            log.record(Event::PhoneFailed, 0, Some(phone)).unwrap();
        }
        let bytes = std::fs::read(directory.path().join(FILE_NAME)).unwrap();
        let records: Vec<Record> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(records.iter().filter(|record| record.event.is_phone()).count(), MAX_PHONE_RECORDS);
        let control: Vec<_> = records.iter().filter(|record| !record.event.is_phone()).collect();
        assert_eq!(control.len(), 11);
        assert!(matches!(control[0].event, Event::Started));
        assert_eq!(control.last().unwrap().attempt, 10);
        assert!(matches!(records.last().unwrap().event, Event::PhoneFailed));
        assert!(String::from_utf8(bytes).unwrap().contains("\"stage\":\"phone-handshake\""));
    }

    /// #1579: a registration refused every few seconds for hours kept only
    /// its own loop. Repeats fold into the records they repeat, so what came
    /// before the loop stays, and the loop says how often and until when.
    #[test]
    fn a_repeating_failure_folds_and_keeps_what_came_before() {
        let directory = tempfile::tempdir().unwrap();
        let mut log = DiagnosticLog::default();
        log.configure(directory.path().to_owned()).unwrap();
        let before = Failure { stage: Stage::Assignment, category: Category::Timeout, http_status: None };
        log.record(Event::Failed, 1, Some(before)).unwrap();
        log.record(Event::Connected, 1, None).unwrap();
        let refused = Failure { stage: Stage::ControlSession, category: Category::Authentication, http_status: None };
        for attempt in 1..=3000 {
            log.record(Event::Connected, attempt, None).unwrap();
            let close = Close { code: 4401, reason: Some("relay_unknown_control_message".into()) };
            log.record_close(Event::Failed, attempt, Some(refused), close).unwrap();
        }
        let bytes = std::fs::read_to_string(directory.path().join(FILE_NAME)).unwrap();
        let records: Vec<Record> = serde_json::from_str(&bytes).unwrap();
        assert_eq!(records.len(), 4, "{bytes}");
        assert!(matches!(records[0].event, Event::Started));
        assert_eq!(records[1].failure, Some(before), "how it began is still there");
        assert!(matches!(records[2].event, Event::Connected));
        assert_eq!(records[2].repeats, 3000);
        assert_eq!(records[3].repeats, 2999);
        assert_eq!(records[3].attempt, 3000);
        assert_eq!(records[3].close_code, Some(4401));
        assert!(records[3].last_timestamp_ms.is_some_and(|last| last >= records[3].timestamp_ms));
        assert!(bytes.contains(r#""closeReason":"relay_unknown_control_message""#), "{bytes}");
        // A reason that is not a relay code is not written.
        log.record_close(Event::Failed, 1, None, Close { code: 4401, reason: Some("host abcDEF0123456789 token=x".into()) }).unwrap();
        let bytes = std::fs::read_to_string(directory.path().join(FILE_NAME)).unwrap();
        assert!(!bytes.contains("abcDEF") && !bytes.contains("token"), "{bytes}");
        // A relaunch reads the folded records back.
        let mut relaunched = DiagnosticLog::default();
        relaunched.configure(directory.path().to_owned()).unwrap();
        assert_eq!(relaunched.records[3].repeats, 2999);
        // One retry is not a loop: it keeps its order.
        let directory = tempfile::tempdir().unwrap();
        let mut log = DiagnosticLog::default();
        log.configure(directory.path().to_owned()).unwrap();
        log.record(Event::Connected, 1, None).unwrap();
        log.record(Event::Failed, 1, Some(refused)).unwrap();
        log.record(Event::Connected, 2, None).unwrap();
        let events: Vec<_> = log.records.iter().map(|record| (record.event, record.repeats)).collect();
        assert_eq!(events, [(Event::Started, 0), (Event::Connected, 0), (Event::Failed, 0), (Event::Connected, 0)]);
        log.record(Event::Failed, 2, Some(refused)).unwrap();
        let events: Vec<_> = log.records.iter().map(|record| (record.event, record.repeats)).collect();
        assert_eq!(events, [(Event::Started, 0), (Event::Connected, 1), (Event::Failed, 1)], "the second round is a loop");
    }

    /// #1282: a phone session's end says why, not `unknown`.
    #[test]
    fn a_phone_session_records_why_it_ended() {
        use crate::phone::{EndReason, Ended, Fault};
        for (fault, expected) in [
            (Fault::FellBehind, Category::FellBehind),
            (Fault::Closed, Category::HostClosed),
            (Fault::Changed, Category::AccountChanged),
            (Fault::Unreadable, Category::Protocol),
            (Fault::TooManyRequests, Category::TooManyRequests),
        ] {
            let error = anyhow::Error::new(fault).context(Stage::PhoneSession);
            assert_eq!(Failure::from_error(&error), Failure { stage: Stage::PhoneSession, category: expected, http_status: None });
            // Through a context too, as an unreadable frame comes.
            let wrapped = anyhow::anyhow!("detail").context(fault).context(Stage::PhoneSession);
            assert_eq!(Failure::from_error(&wrapped).category, expected);
        }
        let directory = tempfile::tempdir().unwrap();
        let mut log = DiagnosticLog::default();
        log.configure(directory.path().to_owned()).unwrap();
        log.record_end(Event::PhoneEnded, 0, None, Some(Ended::closed_with(Some(4000)))).unwrap();
        log.record_end(Event::PhoneEnded, 0, None, Some(Ended::closed_with(Some(4001)))).unwrap();
        log.record_end(Event::PhoneEnded, 0, None, Some(Ended::closed_with(Some(4408)))).unwrap();
        log.record_end(Event::PhoneEnded, 0, None, Some(Ended::closed_with(None))).unwrap();
        log.record_end(Event::PhoneEnded, 0, None, Some(Ended::by(EndReason::StreamEnded))).unwrap();
        log.record(Event::PhoneFailed, 0, Some(Failure::from_error(&anyhow::Error::new(Fault::FellBehind).context(Stage::PhoneSession)))).unwrap();
        let bytes = std::fs::read_to_string(directory.path().join(FILE_NAME)).unwrap();
        assert!(bytes.contains(r#""event":"phone-ended","attempt":0,"retryCount":0,"failure":null,"ended":"phone-closed","closeCode":4000"#), "{bytes}");
        assert!(bytes.contains(r#""ended":"probe-timeout","closeCode":4001"#), "{bytes}");
        assert!(bytes.contains(r#""ended":"relay-closed","closeCode":4408"#), "{bytes}");
        assert!(bytes.contains(r#""ended":"unknown"}"#), "{bytes}");
        assert!(bytes.contains(r#""ended":"stream-ended"}"#), "{bytes}");
        assert!(bytes.contains(r#""category":"fell-behind""#), "{bytes}");
        // Records without an end, as earlier versions wrote them, still read.
        let mut relaunched = DiagnosticLog::default();
        relaunched.configure(directory.path().to_owned()).unwrap();
        assert_eq!(relaunched.records.len(), 8);
        // So do the `phone-closed` events they wrote for every end.
        let earlier = br#"[{"timestampMs":0,"event":"phone-closed","attempt":0,"failure":null,"ended":"phone-closed","closeCode":1000}]"#;
        std::fs::write(directory.path().join(FILE_NAME), earlier).unwrap();
        let mut upgraded = DiagnosticLog::default();
        upgraded.configure(directory.path().to_owned()).unwrap();
        assert!(matches!(upgraded.records[0].event, Event::PhoneEnded));
        assert_eq!(upgraded.records[0].ended, Some(EndReason::PhoneClosed));
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
