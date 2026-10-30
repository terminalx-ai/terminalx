//! Version-1 guest observation framing, byte-compatible with the restricted
//! owner's TXWire: a 4-byte big-endian length, 1...256 KiB, canonical JSON
//! (sorted keys, no whitespace). The probe only sends a hello and reads the
//! owner's offer; it never echoes a challenge or claims an account.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::{
    fs::File,
    io::{self, Read, Write},
    os::{fd::AsRawFd, unix::net::UnixStream},
    time::{Duration, Instant},
};

/// The owner's fixed listener port (TXGuestProtocol.port).
pub const PORT: u32 = 49871;
/// TXWire.read/write bound.
pub const FRAME_LIMIT: usize = 256 * 1024;

pub trait Stream: Read + Write {
    /// Bounds the next blocking read or write.
    fn set_timeout(&self, timeout: Duration) -> io::Result<()>;
}

/// Darwin refuses socket options with EINVAL once the peer has closed. The
/// following read or write then returns at once (data, EOF or EPIPE), so that
/// one error is not a reason to abandon bytes already received.
fn closed_peer(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(e) if e.raw_os_error() == Some(libc::EINVAL) => Ok(()),
        other => other,
    }
}

impl Stream for UnixStream {
    fn set_timeout(&self, timeout: Duration) -> io::Result<()> {
        closed_peer(self.set_read_timeout(Some(timeout)))?;
        closed_peer(self.set_write_timeout(Some(timeout)))
    }
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    match deadline.checked_duration_since(Instant::now()) {
        Some(left) if !left.is_zero() => Ok(left),
        _ => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "observation deadline elapsed",
        )),
    }
}

fn fill(stream: &mut impl Stream, bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        stream.set_timeout(remaining(deadline)?)?;
        match stream.read(&mut bytes[offset..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "owner disconnected mid-frame",
                ))
            }
            Ok(read) => offset += read,
            // A socket timeout surfaces as EAGAIN; the deadline check decides.
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

pub fn write_frame(stream: &mut impl Stream, bytes: &[u8], deadline: Instant) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "frame outside 1...256 KiB",
        ));
    }
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(bytes);
    let mut offset = 0;
    while offset < frame.len() {
        stream.set_timeout(remaining(deadline)?)?;
        match stream.write(&frame[offset..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "owner stopped reading",
                ))
            }
            Ok(written) => offset += written,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(e),
        }
    }
    stream.flush()
}

/// Reads one frame. A length outside the bound is refused before allocating.
pub fn read_frame(stream: &mut impl Stream, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut prefix = [0u8; 4];
    fill(stream, &mut prefix, deadline)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "owner frame outside 1...256 KiB",
        ));
    }
    let mut bytes = vec![0u8; length];
    fill(stream, &mut bytes, deadline)?;
    Ok(bytes)
}

/// The exact canonical hello TXGuestProtocol.observe accepts.
pub fn hello(nonce: &[u8; 32]) -> Vec<u8> {
    format!(
        "{{\"clientNonce\":\"{}\",\"version\":1}}",
        crate::hex(nonce)
    )
    .into_bytes()
}

/// What the probe learned from one owner exchange. Digests only: the offer's
/// host plan is not interpreted and the challenge is never echoed back.
#[derive(Debug)]
pub struct Exchange {
    pub hello_sha256: String,
    pub offer_bytes: usize,
    pub offer_sha256: String,
    pub challenge_sha256: Option<String>,
    pub challenge_version: Option<i64>,
    pub owner_epoch: Option<String>,
    pub nonce_echoed: bool,
    /// Why the offer was not a well-formed version-1 offer, if it was not.
    pub offer_error: Option<&'static str>,
}

impl Exchange {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "helloSha256": self.hello_sha256, "offerBytes": self.offer_bytes,
            "offerSha256": self.offer_sha256, "challengeSha256": self.challenge_sha256,
            "challengeVersion": self.challenge_version, "ownerEpoch": self.owner_epoch,
            "clientNonceEchoed": self.nonce_echoed, "offerError": self.offer_error,
        })
    }
}

pub(crate) fn canonical_object(
    bytes: &[u8],
    keys: &[&str],
) -> Result<serde_json::Map<String, Value>, &'static str> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "not JSON")?;
    let Value::Object(object) = value else {
        return Err("not a JSON object");
    };
    let mut found: Vec<&str> = object.keys().map(String::as_str).collect();
    let mut wanted = keys.to_vec();
    found.sort_unstable();
    wanted.sort_unstable();
    if found != wanted {
        return Err("unexpected keys");
    }
    // serde_json's default map is sorted and compact, like the owner's encoder.
    if serde_json::to_vec(&object).map_err(|_| "not JSON")? != bytes {
        return Err("not canonical JSON");
    }
    Ok(object)
}

fn inspect_offer(
    offer: &[u8],
    nonce: &[u8; 32],
    exchange: &mut Exchange,
) -> Result<(), &'static str> {
    let offer = canonical_object(offer, &["challenge", "hostPlan"])?;
    let challenge = offer["challenge"]
        .as_str()
        .ok_or("challenge is not a string")?;
    offer["hostPlan"]
        .as_str()
        .ok_or("hostPlan is not a string")?;
    let challenge = STANDARD
        .decode(challenge)
        .map_err(|_| "challenge is not base64")?;
    exchange.challenge_sha256 = Some(crate::sha256(&challenge));
    let value: Value = serde_json::from_slice(&challenge).map_err(|_| "challenge is not JSON")?;
    let object = value.as_object().ok_or("challenge is not an object")?;
    exchange.challenge_version = object.get("version").and_then(Value::as_i64);
    exchange.owner_epoch = object
        .get("ownerEpoch")
        .and_then(Value::as_str)
        .filter(|epoch| epoch.len() <= 128)
        .map(str::to_owned);
    exchange.nonce_echoed =
        object.get("clientNonce").and_then(Value::as_str) == Some(crate::hex(nonce).as_str());
    if exchange.challenge_version != Some(1) || !exchange.nonce_echoed {
        return Err("challenge is not a version-1 reply to this hello");
    }
    Ok(())
}

/// Sends the hello, reads one offer frame and records digests. Transport
/// failures are errors; a malformed offer is recorded, not retried.
pub fn exchange(
    stream: &mut impl Stream,
    nonce: &[u8; 32],
    timeout: Duration,
) -> io::Result<Exchange> {
    let deadline = Instant::now() + timeout;
    let hello = hello(nonce);
    write_frame(stream, &hello, deadline)?;
    let offer = read_frame(stream, deadline)?;
    let mut exchange = Exchange {
        hello_sha256: crate::sha256(&hello),
        offer_bytes: offer.len(),
        offer_sha256: crate::sha256(&offer),
        challenge_sha256: None,
        challenge_version: None,
        owner_epoch: None,
        nonce_echoed: false,
        offer_error: None,
    };
    exchange.offer_error = inspect_offer(&offer, nonce, &mut exchange).err();
    Ok(exchange)
}

/// Where a connection attempt stopped, with the kernel's errno.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Failure {
    pub stage: &'static str,
    pub errno: i32,
}

impl Failure {
    fn last(stage: &'static str) -> Failure {
        Failure {
            stage,
            errno: io::Error::last_os_error().raw_os_error().unwrap_or(0),
        }
    }
}

/// A connected guest-to-host vsock stream.
pub struct Vsock(File);

impl Read for Vsock {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}

impl Write for Vsock {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn timeval(timeout: Duration) -> libc::timeval {
    let timeout = timeout.max(Duration::from_millis(1));
    libc::timeval {
        tv_sec: timeout.as_secs() as libc::time_t,
        tv_usec: timeout.subsec_micros() as libc::suseconds_t,
    }
}

impl Stream for Vsock {
    fn set_timeout(&self, timeout: Duration) -> io::Result<()> {
        let value = timeval(timeout);
        for option in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
            // SAFETY: live socket and a correctly sized timeval option value.
            let code = unsafe {
                libc::setsockopt(
                    self.0.as_raw_fd(),
                    libc::SOL_SOCKET,
                    option,
                    (&value as *const libc::timeval).cast(),
                    std::mem::size_of::<libc::timeval>() as libc::socklen_t,
                )
            };
            if code != 0 {
                closed_peer(Err(io::Error::last_os_error()))?;
            }
        }
        Ok(())
    }
}

pub fn host_address() -> libc::sockaddr_vm {
    libc::sockaddr_vm {
        svm_len: std::mem::size_of::<libc::sockaddr_vm>() as u8,
        svm_family: libc::AF_VSOCK as libc::sa_family_t,
        svm_reserved1: 0,
        svm_port: PORT,
        svm_cid: libc::VMADDR_CID_HOST,
    }
}

/// Connects to the host's fixed port. No endpoint, port or CID is configurable.
pub fn connect_host(timeout: Duration) -> Result<Vsock, Failure> {
    // SAFETY: plain socket creation; ownership moves into File on success.
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(Failure::last("socket"));
    }
    // SAFETY: fd is a new socket owned only here.
    let file = unsafe { <File as std::os::fd::FromRawFd>::from_raw_fd(fd) };
    let yes: libc::c_int = 1;
    // SAFETY: live descriptor; only close-on-exec, nonblocking and SIGPIPE flags.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0
            || libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) < 0
            || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0
            || libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&yes as *const libc::c_int).cast(),
                4,
            ) < 0
        {
            return Err(Failure::last("configure"));
        }
    }
    let address = host_address();
    // SAFETY: pointer and length describe the Darwin sockaddr_vm ABI.
    let code = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_vm).cast(),
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    if code != 0 {
        let error = Failure::last("connect");
        if error.errno != libc::EINPROGRESS {
            return Err(error);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Failure {
                    stage: "connect",
                    errno: libc::ETIMEDOUT,
                });
            }
            let mut poll = libc::pollfd {
                fd,
                events: libc::POLLOUT,
                revents: 0,
            };
            // SAFETY: one live pollfd and a bounded timeout.
            let ready = unsafe {
                libc::poll(
                    &mut poll,
                    1,
                    left.as_millis().clamp(1, 60_000) as libc::c_int,
                )
            };
            if ready < 0 {
                let error = Failure::last("poll");
                if error.errno == libc::EINTR {
                    continue;
                }
                return Err(error);
            }
            if ready == 1 {
                break;
            }
        }
        let mut error: libc::c_int = 0;
        let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        // SAFETY: correctly sized writable SO_ERROR output for the live socket.
        if unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut error as *mut libc::c_int).cast(),
                &mut length,
            )
        } != 0
        {
            return Err(Failure::last("getsockopt"));
        }
        if error != 0 {
            return Err(Failure {
                stage: "connect",
                errno: error,
            });
        }
    }
    // Blocking I/O from here, bounded by SO_RCVTIMEO/SO_SNDTIMEO per call.
    // SAFETY: live descriptor; clears only O_NONBLOCK.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) < 0 {
            return Err(Failure::last("configure"));
        }
    }
    Ok(Vsock(file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    const NONCE: [u8; 32] = [0xab; 32];

    fn owner_offer(challenge: &Value, plan: &[u8]) -> Vec<u8> {
        let challenge = serde_json::to_vec(challenge).unwrap();
        serde_json::to_vec(&serde_json::json!({"challenge": STANDARD.encode(challenge), "hostPlan": STANDARD.encode(plan)})).unwrap()
    }

    fn challenge(nonce: &[u8; 32]) -> Value {
        serde_json::json!({"version": 1, "bindingDigest": "b".repeat(64), "ownerEpoch": "epoch-1",
            "clientNonce": crate::hex(nonce), "serverNonce": "c".repeat(64), "planSha256": "d".repeat(64)})
    }

    /// Plays the owner side: reads and checks the hello, answers with `offer`.
    fn owner(offer: Vec<u8>) -> (UnixStream, thread::JoinHandle<Vec<u8>>) {
        let (probe, mut owner) = UnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let hello = read_frame(&mut owner, Instant::now() + Duration::from_secs(3)).unwrap();
            write_frame(&mut owner, &offer, Instant::now() + Duration::from_secs(3)).unwrap();
            hello
        });
        (probe, handle)
    }

    #[test]
    fn hello_is_the_owners_canonical_form() {
        let hello = hello(&NONCE);
        assert_eq!(
            hello,
            format!("{{\"clientNonce\":\"{}\",\"version\":1}}", "ab".repeat(32)).into_bytes()
        );
        let parsed: Value = serde_json::from_slice(&hello).unwrap();
        assert_eq!(
            serde_json::to_vec(&parsed).unwrap(),
            hello,
            "sorted, compact, round-trips"
        );
    }

    #[test]
    fn exchange_records_digests_of_a_well_formed_offer() {
        let challenge_value = challenge(&NONCE);
        let offer = owner_offer(&challenge_value, br#"{"version":2}"#);
        let (mut probe, owner) = owner(offer.clone());
        let result = exchange(&mut probe, &NONCE, Duration::from_secs(3)).unwrap();
        assert_eq!(owner.join().unwrap(), hello(&NONCE));
        assert_eq!(result.offer_sha256, crate::sha256(&offer));
        assert_eq!(result.offer_bytes, offer.len());
        assert_eq!(
            result.challenge_sha256,
            Some(crate::sha256(
                &serde_json::to_vec(&challenge_value).unwrap()
            ))
        );
        assert_eq!(
            (result.challenge_version, result.owner_epoch.as_deref()),
            (Some(1), Some("epoch-1"))
        );
        assert!(result.nonce_echoed && result.offer_error.is_none());
    }

    #[test]
    fn malformed_offers_are_recorded_not_trusted() {
        let other = challenge(&[0x11; 32]);
        let cases: Vec<(Vec<u8>, &str)> = vec![
            (b"[]".to_vec(), "not a JSON object"),
            (
                br#"{"challenge":"e30=","extra":1,"hostPlan":""}"#.to_vec(),
                "unexpected keys",
            ),
            (
                br#"{"hostPlan":"","challenge":"e30="}"#.to_vec(),
                "not canonical JSON",
            ),
            (
                br#"{"challenge":"***","hostPlan":""}"#.to_vec(),
                "challenge is not base64",
            ),
            (
                owner_offer(&other, b"{}"),
                "challenge is not a version-1 reply to this hello",
            ),
        ];
        for (offer, reason) in cases {
            let (mut probe, owner) = owner(offer.clone());
            let result = exchange(&mut probe, &NONCE, Duration::from_secs(3)).unwrap();
            owner.join().unwrap();
            assert_eq!(result.offer_error, Some(reason));
            assert_eq!(result.offer_sha256, crate::sha256(&offer));
        }
    }

    #[test]
    fn oversized_and_empty_frames_are_refused_before_allocation() {
        for length in [0u32, FRAME_LIMIT as u32 + 1, u32::MAX] {
            let (mut probe, mut owner) = UnixStream::pair().unwrap();
            owner.write_all(&length.to_be_bytes()).unwrap();
            let error =
                read_frame(&mut probe, Instant::now() + Duration::from_secs(1)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{length}");
        }
        let (mut probe, _owner) = UnixStream::pair().unwrap();
        assert!(write_frame(&mut probe, &[], Instant::now() + Duration::from_secs(1)).is_err());
        assert!(write_frame(
            &mut probe,
            &vec![b'x'; FRAME_LIMIT + 1],
            Instant::now() + Duration::from_secs(1)
        )
        .is_err());
    }

    #[test]
    fn truncated_frames_and_silence_end_within_the_deadline() {
        let (mut probe, mut owner) = UnixStream::pair().unwrap();
        owner.write_all(&10u32.to_be_bytes()).unwrap();
        owner.write_all(b"abc").unwrap();
        drop(owner);
        let error = read_frame(&mut probe, Instant::now() + Duration::from_secs(1)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);

        let (mut probe, _silent) = UnixStream::pair().unwrap();
        let started = Instant::now();
        let error = exchange(&mut probe, &NONCE, Duration::from_millis(200)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn host_address_matches_the_darwin_abi() {
        let address = host_address();
        assert_eq!(std::mem::size_of::<libc::sockaddr_vm>(), 12);
        assert_eq!(
            (address.svm_len, address.svm_family as i32),
            (12, libc::AF_VSOCK)
        );
        assert_eq!((address.svm_port, address.svm_cid), (49871, 2));
    }

    /// The real connector on this host, which is not a guest: it must fail
    /// with an errno quickly rather than hang or panic. No VM is involved.
    #[test]
    fn real_connector_reports_an_errno_outside_a_guest() {
        let started = Instant::now();
        let failure = connect_host(Duration::from_millis(500))
            .err()
            .expect("host has no guest vsock route");
        assert!(failure.errno != 0, "{failure:?}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
