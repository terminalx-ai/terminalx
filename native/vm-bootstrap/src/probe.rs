//! Validation-only first-boot probe (validation plan P3/P8). It records when,
//! and in what context, launchd started it, then tries the fixed host vsock
//! port for a bounded window. It never reads the seeded key, account records,
//! user files or anything on the host, and it exits 0 on every path so
//! `KeepAlive {SuccessfulExit: false}` cannot turn a refusal into a restart loop.
use crate::{
    fsx::{self, Dir},
    wire::{self, Failure, Stream},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fs::File,
    io::{self, Write},
    os::fd::AsRawFd,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const LABEL: &str = "com.terminalx.next.vm-validation-probe";
/// Must equal the plist's `Program`; tests check both against the plist file.
pub const PROGRAM: &str =
    "/Library/Application Support/TerminalX/VMValidation/terminalx-vm-validation-probe";
pub const STATE: [&str; 4] = ["private", "var", "db", "com.terminalx.next.vm-validation"];
pub const LOG: &str = "launches.jsonl";
pub const KEY: &str = "enrollment.json";
/// The whole log never grows past this; a capped probe writes nothing more.
pub const LOG_LIMIT: u64 = 256 * 1024;
pub const LINE_LIMIT: usize = 16 * 1024;

/// The seeded items whose metadata (never content) each launch records.
pub const ITEMS: [(&str, &[&str], &str); 3] = [
    (
        "plist",
        &["Library", "LaunchDaemons"],
        "com.terminalx.next.vm-validation-probe.plist",
    ),
    (
        "program",
        &[
            "Library",
            "Application Support",
            "TerminalX",
            "VMValidation",
        ],
        "terminalx-vm-validation-probe",
    ),
    ("key", &STATE, KEY),
];

pub struct Schedule {
    pub window: Duration,
    pub interval: Duration,
    pub connect_timeout: Duration,
    pub exchange_timeout: Duration,
}

impl Schedule {
    /// The validation plan's window: an attempt every 10 s for 15 minutes.
    pub const VALIDATION: Schedule = Schedule {
        window: Duration::from_secs(15 * 60),
        interval: Duration::from_secs(10),
        connect_timeout: Duration::from_secs(3),
        exchange_timeout: Duration::from_secs(3),
    };

    pub fn max_attempts(&self) -> u32 {
        (self.window.as_millis() / self.interval.as_millis().max(1)) as u32 + 1
    }
}

/// Filesystem root the probe observes: `/` in the shipped binary. Tests use a
/// disposable directory; no argument or environment variable can change it.
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn system() -> Layout {
        Layout {
            root: PathBuf::from("/"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The state directory or log failed its checks; nothing was written.
    Refused(String),
    /// The log already reached LOG_LIMIT; nothing was written.
    Capped,
    Recorded {
        attempts: u32,
        connected: bool,
    },
}

fn ids() -> (u32, u32, u32, u32) {
    // SAFETY: these calls have no preconditions and cannot fail.
    unsafe {
        (
            libc::getuid(),
            libc::geteuid(),
            libc::getgid(),
            libc::getegid(),
        )
    }
}

fn refuse(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason.into())
}

/// Opens the log by descriptor. Parents may be root's or this user's and must
/// not be group/world writable; the state directory must be private to this
/// user; the log must be one private regular file with no other links.
fn open_log(layout: &Layout) -> io::Result<File> {
    let (_, euid, _, _) = ids();
    let root = Dir::open_root(&layout.root)?;
    let state = root.walk(&STATE, |name, dir| {
        let mode = dir.stat.st_mode & 0o7777;
        if name == STATE[3] {
            if dir.stat.st_uid != euid || mode & 0o077 != 0 {
                return Err(refuse(format!(
                    "state directory must be private to uid {euid}"
                )));
            }
        } else if (dir.stat.st_uid != 0 && dir.stat.st_uid != euid) || mode & 0o022 != 0 {
            return Err(refuse(format!("parent {name} is writable by others")));
        }
        Ok(())
    })?;
    let log = state.open_append(LOG, 0o600)?;
    let stat = fsx::fstat(log.as_raw_fd())?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_nlink != 1
        || stat.st_uid != euid
        || stat.st_mode & 0o7777 != 0o600
    {
        return Err(refuse("log must be one private regular file"));
    }
    Ok(log)
}

/// Appends one bounded line with a single write, then syncs it.
fn append(log: &mut File, value: &Value) -> io::Result<bool> {
    let mut line = serde_json::to_vec(value)?;
    if line.len() >= LINE_LIMIT {
        line = serde_json::to_vec(&json!({"kind": "oversized", "bytes": line.len()}))?;
    }
    line.push(b'\n');
    let size = fsx::fstat(log.as_raw_fd())?.st_size as u64;
    if size + line.len() as u64 > LOG_LIMIT {
        return Ok(false);
    }
    if log.write(&line)? != line.len() {
        return Err(io::Error::new(io::ErrorKind::WriteZero, "partial log line"));
    }
    log.sync_data()?;
    Ok(true)
}

fn sysctl_bytes(name: &str, capacity: usize) -> io::Result<Vec<u8>> {
    let name = CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut bytes = vec![0u8; capacity];
    let mut length = capacity;
    // SAFETY: name is a valid C string; bytes is writable for `length` bytes.
    let code = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if code != 0 {
        return Err(io::Error::last_os_error());
    }
    bytes.truncate(length);
    Ok(bytes)
}

pub fn boot_session() -> Option<String> {
    let bytes = sysctl_bytes("kern.bootsessionuuid", 64).ok()?;
    let text = CStr::from_bytes_until_nul(&bytes).ok()?.to_str().ok()?;
    (!text.is_empty() && text.len() <= 40).then(|| text.to_owned())
}

fn boot_time() -> Value {
    match sysctl_bytes("kern.boottime", std::mem::size_of::<libc::timeval>()) {
        Ok(bytes) if bytes.len() == std::mem::size_of::<libc::timeval>() => {
            // SAFETY: exactly one timeval's bytes; read_unaligned has no alignment needs.
            let time: libc::timeval = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast()) };
            json!({"sec": time.tv_sec, "usec": time.tv_usec})
        }
        _ => Value::Null,
    }
}

fn now() -> Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    json!({"sec": now.as_secs(), "nsec": now.subsec_nanos()})
}

fn describe(stat: Option<libc::stat>) -> Value {
    match stat {
        None => json!({"type": "absent"}),
        Some(s) => json!({"type": fsx::kind(s.st_mode), "uid": s.st_uid, "gid": s.st_gid,
            "mode": format!("{:04o}", s.st_mode & 0o7777), "size": s.st_size}),
    }
}

fn error(e: io::Error) -> Value {
    json!({"type": "error", "errno": e.raw_os_error()})
}

/// lstat of `name` under `dirs`, opening every directory without following links.
fn observe_item(root: &Dir, dirs: &[&str], name: &str) -> Value {
    match root
        .walk(dirs, |_, _| Ok(()))
        .and_then(|dir| dir.stat_at(name))
    {
        Ok(stat) => describe(stat),
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => describe(None),
        Err(e) => error(e),
    }
}

/// The code-signing identity the kernel holds for this running process.
mod signing {
    use serde_json::{json, Value};
    use std::ffi::c_void;

    type Ref = *const c_void;
    const SIGNING_INFORMATION: u32 = 1 << 1; // kSecCSSigningInformation
    const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecCodeCopySelf(flags: u32, code: *mut Ref) -> i32;
        fn SecCodeCopySigningInformation(code: Ref, flags: u32, information: *mut Ref) -> i32;
        static kSecCodeInfoIdentifier: Ref;
        static kSecCodeInfoTeamIdentifier: Ref;
        static kSecCodeInfoUnique: Ref;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: Ref);
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFDataGetTypeID() -> usize;
        fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
        fn CFStringGetCString(string: Ref, buffer: *mut i8, size: isize, encoding: u32) -> u8;
        fn CFDataGetLength(data: Ref) -> isize;
        fn CFDataGetBytePtr(data: Ref) -> *const u8;
    }

    /// SAFETY: `information` must be a live CFDictionary.
    unsafe fn string(information: Ref, key: Ref) -> Option<String> {
        let value = CFDictionaryGetValue(information, key);
        if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
            return None;
        }
        let mut buffer = [0i8; 256];
        if CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) == 0 {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }

    /// SAFETY: `information` must be a live CFDictionary.
    unsafe fn data(information: Ref, key: Ref) -> Option<String> {
        let value = CFDictionaryGetValue(information, key);
        if value.is_null() || CFGetTypeID(value) != CFDataGetTypeID() {
            return None;
        }
        let length = CFDataGetLength(value);
        if !(1..=64).contains(&length) {
            return None;
        }
        Some(crate::hex(std::slice::from_raw_parts(
            CFDataGetBytePtr(value),
            length as usize,
        )))
    }

    pub fn observe() -> Value {
        let mut code: Ref = std::ptr::null();
        // SAFETY: out-pointer to a CF reference; released below on success.
        let status = unsafe { SecCodeCopySelf(0, &mut code) };
        if status != 0 || code.is_null() {
            return json!({"status": status});
        }
        let mut information: Ref = std::ptr::null();
        // SAFETY: code is a live SecCode; information is released below on success.
        let status =
            unsafe { SecCodeCopySigningInformation(code, SIGNING_INFORMATION, &mut information) };
        let result = if status != 0 || information.is_null() {
            json!({"status": status})
        } else {
            // SAFETY: information is a live CFDictionary for the reads, then released once.
            let result = unsafe {
                json!({"status": 0, "identifier": string(information, kSecCodeInfoIdentifier),
                    "teamIdentifier": string(information, kSecCodeInfoTeamIdentifier),
                    "cdhash": data(information, kSecCodeInfoUnique)})
            };
            // SAFETY: released exactly once.
            unsafe { CFRelease(information) };
            result
        };
        // SAFETY: released exactly once.
        unsafe { CFRelease(code) };
        result
    }
}

/// The launch record: process identity, boot, Setup Assistant and console
/// state at launch, seeded-item metadata and this binary's signing identity.
pub fn launch_record(layout: &Layout) -> Value {
    let (uid, euid, gid, egid) = ids();
    let root = Dir::open_root(&layout.root);
    let (setup_done, console, items) = match &root {
        Ok(root) => {
            let missing = |e: &io::Error| e.raw_os_error() == Some(libc::ENOENT);
            let setup = match root
                .walk(&STATE[..3], |_, _| Ok(()))
                .and_then(|db| db.stat_at(".AppleSetupDone"))
            {
                Ok(stat) => json!(stat.is_some()),
                Err(e) if missing(&e) => json!(false),
                Err(e) => error(e),
            };
            let console = match root
                .walk(&["dev"], |_, _| Ok(()))
                .and_then(|dev| dev.stat_at("console"))
            {
                Ok(Some(stat)) => json!(stat.st_uid),
                Ok(None) => Value::Null,
                Err(e) if missing(&e) => Value::Null,
                Err(e) => error(e),
            };
            let items: serde_json::Map<String, Value> = ITEMS
                .iter()
                .map(|(key, dirs, name)| (key.to_string(), observe_item(root, dirs, name)))
                .collect();
            (setup, console, Value::Object(items))
        }
        Err(e) => (
            Value::Null,
            Value::Null,
            json!({"rootErrno": e.raw_os_error()}),
        ),
    };
    json!({"kind": "launch", "version": 1, "label": LABEL, "bootSessionUuid": boot_session(),
        "bootTime": boot_time(), "time": now(), "uid": uid, "euid": euid, "gid": gid, "egid": egid,
        "ppid": std::os::unix::process::parent_id(), "setupDone": setup_done, "consoleUid": console,
        "items": items, "signing": signing::observe()})
}

/// Tries the host port until one connection succeeds or the window ends,
/// at most `schedule.max_attempts()` times. A connection gets exactly one
/// hello/offer exchange; nothing is retried after a connection.
pub fn attempt<S: Stream>(
    schedule: &Schedule,
    mut connect: impl FnMut(Duration) -> Result<S, Failure>,
    mut wait: impl FnMut(Duration),
) -> io::Result<(u32, Value)> {
    let nonce: [u8; 32] = crate::random()?;
    let started = Instant::now();
    let mut attempts = 0u32;
    let mut errors: BTreeMap<Failure, u32> = BTreeMap::new();
    let mut first: Option<Value> = None;
    let mut connection = None;
    while attempts < schedule.max_attempts() {
        attempts += 1;
        match connect(schedule.connect_timeout) {
            Ok(mut stream) => {
                let after = started.elapsed().as_millis() as u64;
                connection = Some(
                    match wire::exchange(&mut stream, &nonce, schedule.exchange_timeout) {
                        Ok(exchange) => json!({"afterMs": after, "exchange": exchange.to_json()}),
                        Err(e) => {
                            json!({"afterMs": after, "exchangeErrno": e.raw_os_error(), "exchangeError": e.kind().to_string()})
                        }
                    },
                );
                break;
            }
            Err(failure) => {
                first.get_or_insert_with(|| {
                    json!({"stage": failure.stage, "errno": failure.errno,
                    "afterMs": started.elapsed().as_millis() as u64})
                });
                *errors.entry(failure).or_default() += 1;
            }
        }
        if started.elapsed() + schedule.interval > schedule.window {
            break;
        }
        wait(schedule.interval);
    }
    let errors: Vec<Value> = errors
        .into_iter()
        .map(|(f, count)| json!({"stage": f.stage, "errno": f.errno, "count": count}))
        .collect();
    let connected = connection.is_some();
    Ok((
        attempts,
        json!({"kind": "vsock", "bootSessionUuid": boot_session(), "port": wire::PORT,
        "attempts": attempts, "errors": errors, "firstError": first, "connected": connected,
        "connection": connection, "elapsedMs": started.elapsed().as_millis() as u64}),
    ))
}

/// One launch: open the log (or refuse), record the launch, run the window,
/// record its result. The caller exits 0 whatever this returns.
pub fn run<S: Stream>(
    layout: &Layout,
    schedule: &Schedule,
    connect: impl FnMut(Duration) -> Result<S, Failure>,
    wait: impl FnMut(Duration),
) -> Outcome {
    let mut log = match open_log(layout) {
        Ok(log) => log,
        Err(e) => return Outcome::Refused(e.to_string()),
    };
    match append(&mut log, &launch_record(layout)) {
        Ok(true) => {}
        Ok(false) => return Outcome::Capped,
        Err(e) => return Outcome::Refused(e.to_string()),
    }
    let (attempts, record) = match attempt(schedule, connect, wait) {
        Ok(result) => result,
        Err(e) => (0, json!({"kind": "vsock", "setupErrno": e.raw_os_error()})),
    };
    let connected = record["connected"] == json!(true);
    match append(&mut log, &record) {
        Ok(true) => Outcome::Recorded {
            attempts,
            connected,
        },
        Ok(false) => Outcome::Capped,
        Err(e) => Outcome::Refused(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::{
            fs::{symlink, PermissionsExt},
            net::UnixStream,
        },
        path::Path,
        sync::{Arc, Mutex},
    };

    fn fast() -> Schedule {
        Schedule {
            window: Duration::from_millis(200),
            interval: Duration::from_millis(50),
            connect_timeout: Duration::from_millis(50),
            exchange_timeout: Duration::from_millis(500),
        }
    }

    /// A disposable root shaped like the seeded guest volume.
    fn guest() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join(STATE.join("/"));
        std::fs::create_dir_all(&state).unwrap();
        for dir in ["private", "private/var", "private/var/db"] {
            std::fs::set_permissions(
                temp.path().join(dir),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(state.join(KEY), b"{}").unwrap();
        temp
    }

    fn layout(temp: &tempfile::TempDir) -> Layout {
        Layout {
            root: temp.path().to_path_buf(),
        }
    }

    fn lines(temp: &tempfile::TempDir) -> Vec<Value> {
        let text = std::fs::read_to_string(temp.path().join(STATE.join("/")).join(LOG)).unwrap();
        text.lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn refusing(errno: i32) -> impl FnMut(Duration) -> Result<UnixStream, Failure> {
        move |_| {
            Err(Failure {
                stage: "connect",
                errno,
            })
        }
    }

    #[test]
    fn shipped_schedule_is_fifteen_minutes_every_ten_seconds() {
        assert_eq!(Schedule::VALIDATION.max_attempts(), 91);
        assert_eq!(fast().max_attempts(), 5);
    }

    #[test]
    fn records_launch_identity_and_bounded_failed_attempts() {
        let temp = guest();
        let waits = Arc::new(Mutex::new(Vec::new()));
        let seen = waits.clone();
        let outcome = run(&layout(&temp), &fast(), refusing(libc::ENODEV), move |d| {
            seen.lock().unwrap().push(d);
            std::thread::sleep(d)
        });
        let Outcome::Recorded {
            attempts,
            connected: false,
        } = outcome
        else {
            panic!("{outcome:?}")
        };
        assert!((1..=5).contains(&attempts), "{attempts}");
        assert!(waits
            .lock()
            .unwrap()
            .iter()
            .all(|d| *d == Duration::from_millis(50)));
        let lines = lines(&temp);
        assert_eq!(lines.len(), 2);
        let (launch, vsock) = (&lines[0], &lines[1]);
        let (uid, euid, gid, egid) = ids();
        assert_eq!(launch["kind"], "launch");
        assert_eq!(
            (launch["uid"].as_u64(), launch["euid"].as_u64()),
            (Some(uid.into()), Some(euid.into()))
        );
        assert_eq!(
            (launch["gid"].as_u64(), launch["egid"].as_u64()),
            (Some(gid.into()), Some(egid.into()))
        );
        assert_eq!(
            launch["ppid"].as_u64(),
            Some(std::os::unix::process::parent_id().into())
        );
        assert_eq!(launch["bootSessionUuid"].as_str().map(str::len), Some(36));
        assert!(launch["bootTime"]["sec"].as_i64().unwrap() > 1_600_000_000);
        assert_eq!(launch["setupDone"], false);
        assert_eq!(launch["consoleUid"], Value::Null);
        assert_eq!(launch["items"]["key"]["type"], "file");
        assert_eq!(launch["items"]["key"]["size"], 2, "metadata only");
        assert_eq!(launch["items"]["plist"]["type"], "absent");
        assert_eq!(vsock["attempts"].as_u64(), Some(attempts.into()));
        assert_eq!(
            vsock["errors"],
            json!([{"stage": "connect", "errno": libc::ENODEV, "count": attempts}])
        );
        assert_eq!(vsock["firstError"]["errno"], libc::ENODEV);
        assert_eq!(vsock["connected"], false);
        assert_eq!(vsock["bootSessionUuid"], launch["bootSessionUuid"]);
    }

    #[test]
    fn setup_assistant_state_and_console_owner_are_observed() {
        let temp = guest();
        std::fs::write(temp.path().join("private/var/db/.AppleSetupDone"), b"").unwrap();
        std::fs::create_dir(temp.path().join("dev")).unwrap();
        std::fs::write(temp.path().join("dev/console"), b"").unwrap();
        let record = launch_record(&layout(&temp));
        assert_eq!(record["setupDone"], true);
        assert_eq!(record["consoleUid"].as_u64(), Some(ids().1.into()));
    }

    #[test]
    fn signing_identity_of_this_ad_hoc_test_binary() {
        let signing = signing::observe();
        assert_eq!(signing["status"], 0, "{signing}");
        assert_eq!(
            signing["cdhash"].as_str().map(str::len),
            Some(40),
            "{signing}"
        );
        assert_eq!(
            signing["teamIdentifier"],
            Value::Null,
            "linker ad hoc signature has no team"
        );
    }

    #[test]
    fn one_connection_gets_one_exchange_and_ends_the_window() {
        let temp = guest();
        let calls = Arc::new(Mutex::new(0));
        let counted = calls.clone();
        let connect = move |_| {
            *counted.lock().unwrap() += 1;
            let (probe, mut owner) = UnixStream::pair().unwrap();
            std::thread::spawn(move || {
                let hello =
                    wire::read_frame(&mut owner, Instant::now() + Duration::from_secs(2)).unwrap();
                let nonce: Value = serde_json::from_slice(&hello).unwrap();
                let challenge = serde_json::to_vec(
                    &json!({"clientNonce": nonce["clientNonce"], "ownerEpoch": "e", "version": 1}),
                )
                .unwrap();
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD;
                let offer = serde_json::to_vec(
                    &json!({"challenge": b64.encode(&challenge), "hostPlan": b64.encode(b"{}")}),
                )
                .unwrap();
                wire::write_frame(&mut owner, &offer, Instant::now() + Duration::from_secs(2))
                    .unwrap();
            });
            Ok(probe)
        };
        let outcome = run(&layout(&temp), &fast(), connect, |_| {
            panic!("no wait after a connection")
        });
        assert_eq!(
            outcome,
            Outcome::Recorded {
                attempts: 1,
                connected: true
            }
        );
        assert_eq!(*calls.lock().unwrap(), 1);
        let vsock = &lines(&temp)[1];
        let exchange = &vsock["connection"]["exchange"];
        assert_eq!(exchange["clientNonceEchoed"], true);
        assert_eq!(exchange["ownerEpoch"], "e");
        assert_eq!(exchange["offerError"], Value::Null);
    }

    #[test]
    fn a_silent_owner_ends_the_exchange_without_retrying() {
        let temp = guest();
        let mut owners = Vec::new();
        let connect = move |_| {
            let (probe, owner) = UnixStream::pair().unwrap();
            owners.push(owner);
            Ok(probe)
        };
        let started = Instant::now();
        let outcome = run(&layout(&temp), &fast(), connect, |_| panic!("no retry"));
        assert_eq!(
            outcome,
            Outcome::Recorded {
                attempts: 1,
                connected: true
            }
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(lines(&temp)[1]["connection"]["exchangeError"], "timed out");
    }

    #[test]
    fn refuses_without_writing_when_paths_are_not_private_or_are_links() {
        type Mutate = fn(&Path);
        let cases: [(&str, Mutate); 6] = [
            ("missing state", |r| {
                std::fs::remove_dir_all(r.join(STATE.join("/"))).unwrap()
            }),
            ("open state", |r| {
                std::fs::set_permissions(
                    r.join(STATE.join("/")),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap()
            }),
            ("writable parent", |r| {
                std::fs::set_permissions(
                    r.join("private/var/db"),
                    std::fs::Permissions::from_mode(0o777),
                )
                .unwrap()
            }),
            ("linked state", |r| {
                let state = r.join(STATE.join("/"));
                std::fs::rename(&state, r.join("elsewhere")).unwrap();
                symlink(r.join("elsewhere"), &state).unwrap();
            }),
            ("linked log", |r| {
                symlink(r.join("target"), r.join(STATE.join("/")).join(LOG)).unwrap()
            }),
            ("hard-linked log", |r| {
                let log = r.join(STATE.join("/")).join(LOG);
                std::fs::write(&log, b"").unwrap();
                std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o600)).unwrap();
                std::fs::hard_link(&log, r.join("second-name")).unwrap();
            }),
        ];
        for (name, mutate) in cases {
            let temp = guest();
            mutate(temp.path());
            let outcome = run(&layout(&temp), &fast(), refusing(libc::ENODEV), |_| {
                panic!("{name}: refused before any attempt")
            });
            assert!(
                matches!(outcome, Outcome::Refused(_)),
                "{name}: {outcome:?}"
            );
            assert!(
                !temp.path().join("target").exists(),
                "{name}: never followed a link"
            );
            assert!(
                !temp.path().join("elsewhere").join(LOG).exists(),
                "{name}: wrote through a link"
            );
        }
    }

    #[test]
    fn the_log_is_capped_and_lines_are_bounded() {
        let temp = guest();
        let log = temp.path().join(STATE.join("/")).join(LOG);
        std::fs::write(&log, vec![b'x'; LOG_LIMIT as usize - 10]).unwrap();
        std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o600)).unwrap();
        let outcome = run(&layout(&temp), &fast(), refusing(libc::ENODEV), |_| {
            panic!("capped before any attempt")
        });
        assert_eq!(outcome, Outcome::Capped);
        assert_eq!(
            std::fs::metadata(&log).unwrap().len(),
            LOG_LIMIT - 10,
            "nothing appended"
        );

        let temp = guest();
        let mut file = open_log(&layout(&temp)).unwrap();
        assert!(append(
            &mut file,
            &json!({"kind": "x", "pad": "y".repeat(LINE_LIMIT)})
        )
        .unwrap());
        let line: Value = lines(&temp)[0].clone();
        assert_eq!(line["kind"], "oversized");
    }

    #[test]
    fn plist_program_and_label_match_the_probe() {
        let plist = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("com.terminalx.next.vm-validation-probe.plist");
        let output = std::process::Command::new("/usr/bin/plutil")
            .args(["-convert", "json", "-o", "-"])
            .arg(&plist)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            value,
            json!({"Label": LABEL, "Program": PROGRAM, "RunAtLoad": true, "KeepAlive": {"SuccessfulExit": false}})
        );
        assert_eq!(ITEMS[0].2, format!("{LABEL}.plist"));
        assert_eq!(format!("/{}/{}", ITEMS[1].1.join("/"), ITEMS[1].2), PROGRAM);
    }
}
