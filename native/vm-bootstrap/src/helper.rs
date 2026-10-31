//! The production first-boot guest helper (design stages 5, 7 and 8; the entry
//! point is `src/bin/helper.rs`). launchd starts it as root from the seeded
//! plist. It reads the seeded per-VM key from its root-only state directory,
//! waits without connecting until Setup Assistant has finished and a personal
//! account exists, then makes its enrollment and follows the restricted owner:
//! it reports the accounts, accepts only the person's relayed confirmation,
//! installs the relayed key grant as that account, and reports the guest's
//! existing public host key.
//!
//! It waits before connecting because the owner reads the account report
//! within one frame deadline of its acceptance, and an acceptance claims the
//! VM's only enrollment. Each attempt is journaled before it starts and the
//! attempts are bounded across launches, so a lost acceptance never becomes
//! repeated claims. It never chooses or consents to an account, generates a
//! key or changes sshd, and it exits 0 on every path so `KeepAlive
//! {SuccessfulExit: false}` cannot turn a refusal into a restart loop.
//! Retirement (design stage 9) needs a final acknowledgement the owner does
//! not send yet, so the seeded items stay in place.
use crate::{
    account,
    child::{self, Installer},
    enroll::{self, Seed, Session},
    fsx::Dir,
    hostkey,
    wire::{self, Failure, Stream},
};
use serde_json::{json, Value};
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};

pub const LABEL: &str = "com.terminalx.next.vm-bootstrap";
/// Must equal the plist's `Program`; tests check both against the plist file
/// and the seeder's production profile.
pub const PROGRAM: &str =
    "/Library/Application Support/TerminalX/VMBootstrap/terminalx-vm-bootstrap";
pub const STATE: [&str; 4] = ["private", "var", "db", "com.terminalx.next.vm-bootstrap"];
pub const KEY: &str = "enrollment.json";
/// Written by Setup Assistant once the person has finished it.
const SETUP_DONE: [&str; 4] = ["private", "var", "db", ".AppleSetupDone"];
/// The public host key's directory (`/etc` links to `/private/etc`).
const SSH: [&str; 3] = ["private", "etc", "ssh"];
const ENROLLED: &str = "enrolled.json";
const RESULT: &str = "session-result.json";

pub struct Schedule {
    /// Between checks for a finished Setup Assistant, and between tries.
    pub interval: Duration,
    /// Connection tries in one launch once an account exists. The next boot
    /// tries again; no attempt is journaled without a connection.
    pub connects: u32,
    pub connect_timeout: Duration,
    /// Bound on each enrollment frame, as the owner bounds its own reads.
    pub exchange: Duration,
    /// How long each later step waits for the person or the host.
    pub person: Duration,
    /// Enrollment attempts for this seed, counted across launches.
    pub attempts: u32,
}

impl Schedule {
    /// A try every 10 s for 15 minutes; the person's steps wait as long as the
    /// owner's own confirmation wait (6 h).
    pub const PRODUCTION: Schedule = Schedule {
        interval: Duration::from_secs(10),
        connects: 90,
        connect_timeout: Duration::from_secs(3),
        exchange: Duration::from_secs(3),
        person: Duration::from_secs(6 * 3600),
        attempts: 3,
    };
}

/// Filesystem root the helper works under: `/` in the shipped binary. Tests
/// use a disposable directory; no argument or environment variable changes it.
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn system() -> Layout {
        Layout {
            root: PathBuf::from("/"),
        }
    }

    fn path(&self, components: &[&str]) -> PathBuf {
        components
            .iter()
            .fold(self.root.clone(), |path, name| path.join(name))
    }

    pub fn state(&self) -> PathBuf {
        self.path(&STATE)
    }

    pub fn ssh(&self) -> PathBuf {
        self.path(&SSH)
    }

    fn setup_done(&self) -> bool {
        std::fs::symlink_metadata(self.path(&SETUP_DONE)).is_ok_and(|m| m.file_type().is_file())
    }
}

/// What the helper uses of the machine it runs on; tests supply their own.
pub trait Guest {
    type Stream: Stream;
    fn connect(&mut self, timeout: Duration) -> Result<Self::Stream, Failure>;
    fn sleep(&mut self, duration: Duration);
    /// The local personal accounts, as `account::observe` reports them.
    fn accounts(&mut self) -> Vec<Value>;
}

/// The guest itself: the host's fixed vsock port, the real clock and the
/// local account database.
pub struct System;

impl Guest for System {
    type Stream = wire::Vsock;

    fn connect(&mut self, timeout: Duration) -> Result<wire::Vsock, Failure> {
        wire::connect_host(timeout)
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration)
    }

    fn accounts(&mut self) -> Vec<Value> {
        account::observe()
    }
}

#[derive(Debug)]
pub enum Outcome {
    /// The state directory or seed failed its checks; nothing was attempted.
    Refused(String),
    /// An earlier launch was accepted. The owner admits nothing more, and
    /// enrollment is never repeated.
    EnrolledEarlier,
    /// Every journaled attempt ended without an acceptance.
    AttemptsSpent(Option<String>),
    /// No connection in this launch's window; no attempt was journaled.
    Unreachable(Failure),
    /// The session ran; what it reached is journaled in `session-result.json`.
    Finished(Value),
}

fn refused(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason)
}

fn record(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("JSON values always serialize")
}

/// The state directory, private to `owner` (root in production), and the
/// seeded record in it: one link, private to `owner`, bounded, read once.
fn open(layout: &Layout, owner: u32) -> io::Result<(Dir, Seed)> {
    let state = Dir::open_root(&layout.state())?;
    if state.stat.st_uid != owner || state.stat.st_mode & 0o077 != 0 {
        return Err(refused("the helper state directory is not private to root"));
    }
    let (file, stat) = state.open_regular(KEY)?;
    if stat.st_uid != owner || stat.st_mode & 0o077 != 0 || stat.st_nlink != 1 {
        return Err(refused("the enrollment record is not private to root"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut &file)
        .take(4097)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(refused("the enrollment record exceeds its bound"));
    }
    Ok((state, Seed::parse(&bytes)?))
}

fn attempt_name(attempt: u32) -> String {
    format!("enrollment-attempt-{attempt}.json")
}

/// The first unused attempt number, or `None` once all are spent.
fn next_attempt(state: &Dir, limit: u32) -> io::Result<Option<u32>> {
    for attempt in 1..=limit {
        if state.stat_at(&attempt_name(attempt))?.is_none() {
            return Ok(Some(attempt));
        }
    }
    Ok(None)
}

fn connect<G: Guest>(guest: &mut G, schedule: &Schedule) -> Result<G::Stream, Failure> {
    let mut tries = 0;
    loop {
        match guest.connect(schedule.connect_timeout) {
            Ok(stream) => return Ok(stream),
            Err(failure) => {
                tries += 1;
                if tries >= schedule.connects {
                    return Err(failure);
                }
                guest.sleep(schedule.interval);
            }
        }
    }
}

fn claims() -> Value {
    // SAFETY: geteuid has no preconditions.
    json!({"euid": unsafe { libc::geteuid() }, "label": LABEL})
}

/// After the owner's acceptance: reports `accounts`, then follows the owner,
/// each step waiting up to `wait`: the person's confirmation, the key grant
/// installed by `installer` as the confirmed account, and, only after that
/// install, the existing public host key in `ssh_dir` (which, like the key,
/// must belong to `ssh_owner`). The session ends at the first refusal.
#[allow(clippy::too_many_arguments)]
pub fn converse(
    session: &mut Session,
    stream: &mut impl Stream,
    bootstrap_id: &str,
    accounts: &[Value],
    installer: &mut impl Installer,
    ssh_dir: &Path,
    ssh_owner: u32,
    wait: Duration,
) -> io::Result<Value> {
    session.report_accounts(stream, accounts)?;
    let account = session.await_confirmation(stream, accounts, wait)?;
    let (stage, key_reference) =
        child::grant_and_report(session, stream, &account, bootstrap_id, wait, installer)?;
    let host_key = if stage == "publicKeyInstalled" {
        hostkey::report_host_key(session, stream, &key_reference, ssh_dir, ssh_owner, wait)?
    } else {
        None
    };
    Ok(
        json!({"confirmed": account.name, "confirmationSha256": account.confirmation_sha256,
        "keyStage": stage, "hostKey": host_key}),
    )
}

/// One launch. `owner` is the uid that must own the state directory, the
/// seeded record and the SSH directory: root in production.
pub fn run(
    layout: &Layout,
    owner: u32,
    schedule: &Schedule,
    guest: &mut impl Guest,
    installer: &mut impl Installer,
) -> Outcome {
    let (state, seed) = match open(layout, owner) {
        Ok(opened) => opened,
        Err(error) => return Outcome::Refused(error.to_string()),
    };
    let mut last_error = None;
    loop {
        match state.stat_at(ENROLLED) {
            Ok(None) => {}
            Ok(Some(_)) => return Outcome::EnrolledEarlier,
            Err(error) => return Outcome::Refused(error.to_string()),
        }
        let attempt = match next_attempt(&state, schedule.attempts) {
            Ok(Some(attempt)) => attempt,
            Ok(None) => return Outcome::AttemptsSpent(last_error),
            Err(error) => return Outcome::Refused(error.to_string()),
        };
        // Nothing to report until the person has finished Setup Assistant.
        while !(layout.setup_done() && !guest.accounts().is_empty()) {
            guest.sleep(schedule.interval);
        }
        let mut stream = match connect(guest, schedule) {
            Ok(stream) => stream,
            Err(failure) => return Outcome::Unreachable(failure),
        };
        let started = json!({"attempt": attempt, "version": 1});
        if let Err(error) = state.publish_new(&attempt_name(attempt), &record(&started)) {
            return Outcome::Refused(error.to_string());
        }
        let (mut session, challenge) =
            match enroll::enroll(&mut stream, &seed, &claims(), schedule.exchange) {
                Ok(accepted) => accepted,
                Err(error) => {
                    last_error = Some(error.to_string());
                    guest.sleep(schedule.interval);
                    continue;
                }
            };
        // Accepted: this VM's only enrollment is claimed.
        let enrolled = json!({"attempt": attempt, "challengeSha256": challenge, "version": 1});
        if let Err(error) = state.publish_new(ENROLLED, &record(&enrolled)) {
            return Outcome::Refused(error.to_string());
        }
        let accounts = guest.accounts();
        let reached = converse(
            &mut session,
            &mut stream,
            &seed.bootstrap_id,
            &accounts,
            installer,
            &layout.ssh(),
            owner,
            schedule.person,
        )
        .unwrap_or_else(|error| json!({"error": error.to_string()}));
        let result = json!({"challengeSha256": challenge, "reached": reached, "version": 1});
        return match state.publish_new(RESULT, &record(&result)) {
            Ok(()) => Outcome::Finished(result),
            Err(error) => Outcome::Refused(error.to_string()),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        account::ConfirmedAccount,
        keys::KeyGrant,
        wire::{read_frame, write_frame},
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::{
        os::unix::{fs::PermissionsExt, net::UnixStream},
        thread,
        time::Instant,
    };

    const SEEDED: [u8; 32] = [0x5a; 32];
    const BOOT: &str = "6f1d7c2e-0b9a-4c55-9d1e-2a3b4c5d6e7f";
    const PUBLIC: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
    const REFERENCE: &str = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const SCHEDULE: Schedule = Schedule {
        interval: Duration::from_millis(1),
        connects: 2,
        connect_timeout: Duration::from_secs(1),
        exchange: Duration::from_secs(3),
        person: Duration::from_secs(3),
        attempts: 3,
    };

    fn euid() -> u32 {
        // SAFETY: no preconditions.
        unsafe { libc::geteuid() }
    }

    fn private(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A disposable guest root with this helper's seeded state.
    fn guest_root() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout {
            root: temp.path().to_path_buf(),
        };
        std::fs::create_dir_all(layout.state()).unwrap();
        private(&layout.state(), 0o700);
        let seed = json!({"bootstrapId": BOOT, "key": STANDARD.encode(SEEDED),
            "seedId": "00112233445566778899aabbccddeeff", "version": 1});
        std::fs::write(layout.state().join(KEY), record(&seed)).unwrap();
        private(&layout.state().join(KEY), 0o600);
        std::fs::create_dir_all(layout.ssh()).unwrap();
        private(&layout.ssh(), 0o755);
        temp
    }

    fn layout(temp: &tempfile::TempDir) -> Layout {
        Layout {
            root: temp.path().to_path_buf(),
        }
    }

    fn finish_setup(layout: &Layout) {
        std::fs::write(layout.path(&SETUP_DONE), b"").unwrap();
    }

    fn state_names(layout: &Layout) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(layout.state())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// This host's own personal account, as the helper reports it. Looked up
    /// with the reentrant call, since tests run in parallel threads.
    fn mine() -> Value {
        // SAFETY: getpwuid_r fills only the given entry and buffer, whose
        // strings are copied before the buffer goes out of scope.
        unsafe {
            let mut entry: libc::passwd = std::mem::zeroed();
            let mut buffer = vec![0 as libc::c_char; 16 * 1024];
            let mut found = std::ptr::null_mut();
            libc::getpwuid_r(
                libc::getuid(),
                &mut entry,
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut found,
            );
            assert!(!found.is_null(), "this host's user has an account entry");
            let text =
                |p: *const libc::c_char| std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned();
            account::describe(
                &text(entry.pw_name),
                entry.pw_uid,
                entry.pw_gid,
                &text(entry.pw_dir),
            )
            .expect("this host's user has a /Users home")
        }
    }

    struct Fake {
        ends: Vec<UnixStream>,
        accounts: Vec<Value>,
        connects: u32,
        sleeps: u32,
        /// Setup Assistant finishes once this many sleeps have passed.
        setup_after: Option<(u32, PathBuf)>,
        /// Sleeps that had passed at the first connection.
        first_connect_after: Option<u32>,
    }

    impl Fake {
        fn new(ends: Vec<UnixStream>, accounts: Vec<Value>) -> Fake {
            Fake {
                ends,
                accounts,
                connects: 0,
                sleeps: 0,
                setup_after: None,
                first_connect_after: None,
            }
        }
    }

    impl Guest for Fake {
        type Stream = UnixStream;

        fn connect(&mut self, _: Duration) -> Result<UnixStream, Failure> {
            self.connects += 1;
            self.first_connect_after.get_or_insert(self.sleeps);
            self.ends.pop().ok_or(Failure {
                stage: "connect",
                errno: libc::ECONNREFUSED,
            })
        }

        fn sleep(&mut self, _: Duration) {
            self.sleeps += 1;
            if let Some((after, marker)) = &self.setup_after {
                if self.sleeps == *after {
                    std::fs::write(marker, b"").unwrap();
                }
            }
        }

        fn accounts(&mut self) -> Vec<Value> {
            self.accounts.clone()
        }
    }

    /// Reports a fixed stage and records each grant; it never writes.
    struct Stage(&'static str, Vec<String>);

    impl Installer for Stage {
        fn install(&mut self, account: &ConfirmedAccount, grant: &KeyGrant) -> String {
            self.1
                .push(format!("{}:{}", account.name, grant.key_reference));
            self.0.into()
        }
    }

    /// A conforming owner for one session: accepts the enrollment, relays the
    /// person's confirmation of `account` and a key grant, and returns every
    /// helper frame until the helper closes.
    fn owner(mut end: UnixStream, key: [u8; 32], account: Value) -> io::Result<Vec<Value>> {
        let deadline = || Instant::now() + Duration::from_secs(3);
        let (_, session) = enroll::accept_fixture(&mut end, key, |_| {})?;
        let mut frames = vec![Session::helper_body(
            &session,
            0,
            &read_frame(&mut end, deadline())?,
        )?];
        let mut confirmation = account.clone();
        confirmation["confirmed"] = json!(true);
        confirmation["confirmationSha256"] = json!("c".repeat(64));
        let relayed = json!({"accountConfirmation": confirmation});
        write_frame(
            &mut end,
            &Session::owner_frame(&session, 1, &relayed),
            deadline(),
        )?;
        frames.push(Session::helper_body(
            &session,
            1,
            &read_frame(&mut end, deadline())?,
        )?);
        let grant = json!({"keyGrant": {"keyReference": REFERENCE, "publicKey": PUBLIC}});
        write_frame(
            &mut end,
            &Session::owner_frame(&session, 2, &grant),
            deadline(),
        )?;
        let mut seq = 2;
        while let Ok(frame) = read_frame(&mut end, deadline()) {
            frames.push(Session::helper_body(&session, seq, &frame)?);
            seq += 1;
        }
        Ok(frames)
    }

    fn host_key(fill: u8) -> String {
        let mut bytes = 11_u32.to_be_bytes().to_vec();
        bytes.extend(b"ssh-ed25519");
        bytes.extend(32_u32.to_be_bytes());
        bytes.extend([fill; 32]);
        format!("ssh-ed25519 {}", STANDARD.encode(bytes))
    }

    #[test]
    fn plist_program_label_and_state_match_the_seeders_production_items() {
        let plist = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("{LABEL}.plist"));
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
        let items = &crate::seed::PRODUCTION.items;
        assert_eq!(items[0].name, format!("{LABEL}.plist"));
        assert_eq!(
            format!("/{}/{}", items[1].dirs.join("/"), items[1].name),
            PROGRAM
        );
        assert_eq!((items[2].dirs, items[2].name), (&STATE[..], KEY));
    }

    /// Spoils one part of a seeded guest root.
    type Change = fn(&Layout);

    #[test]
    fn a_state_or_seed_that_is_not_private_and_exact_refuses_before_any_connection() {
        let cases: [(&str, Change); 6] = [
            ("no state", |l| std::fs::remove_dir_all(l.state()).unwrap()),
            ("readable state", |l| private(&l.state(), 0o750)),
            ("readable seed", |l| private(&l.state().join(KEY), 0o640)),
            ("linked seed", |l| {
                std::fs::hard_link(l.state().join(KEY), l.root.join("alias")).unwrap()
            }),
            ("aliased seed", |l| {
                std::fs::rename(l.state().join(KEY), l.root.join("moved")).unwrap();
                std::os::unix::fs::symlink(l.root.join("moved"), l.state().join(KEY)).unwrap();
            }),
            ("malformed seed", |l| {
                std::fs::write(l.state().join(KEY), b"{\"version\": 1}").unwrap()
            }),
        ];
        for (name, change) in cases {
            let temp = guest_root();
            let layout = layout(&temp);
            finish_setup(&layout);
            change(&layout);
            let before = layout.state().exists().then(|| state_names(&layout));
            let mut guest = Fake::new(vec![], vec![mine()]);
            let outcome = run(
                &layout,
                euid(),
                &SCHEDULE,
                &mut guest,
                &mut Stage("refused", vec![]),
            );
            assert!(
                matches!(outcome, Outcome::Refused(_)),
                "{name}: {outcome:?}"
            );
            assert_eq!(guest.connects, 0, "{name}");
            assert_eq!(
                layout.state().exists().then(|| state_names(&layout)),
                before,
                "{name}"
            );
        }
        let temp = guest_root();
        let outcome = run(
            &layout(&temp),
            euid() + 1,
            &SCHEDULE,
            &mut Fake::new(vec![], vec![]),
            &mut Stage("refused", vec![]),
        );
        assert!(
            matches!(outcome, Outcome::Refused(_)),
            "another owner: {outcome:?}"
        );
    }

    #[test]
    fn it_waits_for_setup_assistant_then_enrolls_once_and_never_again() {
        let temp = guest_root();
        let layout = layout(&temp);
        let (helper_end, owner_end) = UnixStream::pair().unwrap();
        let owner = thread::spawn(move || owner(owner_end, SEEDED, mine()));
        let mut guest = Fake::new(vec![helper_end], vec![mine()]);
        guest.setup_after = Some((3, layout.path(&SETUP_DONE)));
        // The real installer: unprivileged, it refuses before any fork or write.
        let mut installer = child::Forking {
            state: temp.path().join("installer-state"),
        };
        let outcome = run(&layout, euid(), &SCHEDULE, &mut guest, &mut installer);
        let frames = owner.join().unwrap().unwrap();
        assert_eq!(
            (guest.connects, guest.first_connect_after),
            (1, Some(3)),
            "no connection before Setup Assistant finished"
        );
        let Outcome::Finished(result) = outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(
            result["reached"],
            json!({"confirmed": mine()["name"], "confirmationSha256": "c".repeat(64), "keyStage": "refused", "hostKey": null})
        );
        assert_eq!(
            frames,
            vec![
                json!({"accounts": [mine()]}),
                json!({"accountConfirmed": {"confirmationSha256": "c".repeat(64)}}),
                json!({"keyResult": {"keyReference": REFERENCE, "stage": "refused"}}),
            ],
            "no host key after a refused install"
        );
        assert_eq!(
            state_names(&layout),
            [ENROLLED, "enrollment-attempt-1.json", KEY, RESULT]
        );
        let journaled: Value =
            serde_json::from_slice(&std::fs::read(layout.state().join(RESULT)).unwrap()).unwrap();
        assert_eq!(journaled, result);
        let secret = [STANDARD.encode(SEEDED), crate::hex(&SEEDED)];
        for name in [ENROLLED, "enrollment-attempt-1.json", RESULT] {
            let text = std::fs::read_to_string(layout.state().join(name)).unwrap();
            assert!(
                !secret.iter().any(|s| text.contains(s.as_str())),
                "{name} names the key"
            );
        }
        assert!(!temp.path().join("installer-state").exists());

        // Every later launch: the owner admits nothing more, so nothing is tried.
        let mut again = Fake::new(vec![], vec![mine()]);
        let outcome = run(
            &layout,
            euid(),
            &SCHEDULE,
            &mut again,
            &mut Stage("publicKeyInstalled", vec![]),
        );
        assert!(matches!(outcome, Outcome::EnrolledEarlier), "{outcome:?}");
        assert_eq!(again.connects, 0);
    }

    #[test]
    fn after_its_own_install_it_reports_only_the_existing_public_host_key() {
        let temp = guest_root();
        let layout = layout(&temp);
        finish_setup(&layout);
        std::fs::write(
            layout.ssh().join(hostkey::HOST_KEY),
            format!("{} root@guest\n", host_key(4)),
        )
        .unwrap();
        private(&layout.ssh().join(hostkey::HOST_KEY), 0o644);
        let (helper_end, owner_end) = UnixStream::pair().unwrap();
        let owner = thread::spawn(move || owner(owner_end, SEEDED, mine()));
        let mut installer = Stage("publicKeyInstalled", vec![]);
        let outcome = run(
            &layout,
            euid(),
            &SCHEDULE,
            &mut Fake::new(vec![helper_end], vec![mine()]),
            &mut installer,
        );
        let frames = owner.join().unwrap().unwrap();
        let Outcome::Finished(result) = outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(
            installer.1,
            vec![format!("{}:{REFERENCE}", mine()["name"].as_str().unwrap())]
        );
        assert_eq!(result["reached"]["keyStage"], "publicKeyInstalled");
        assert_eq!(result["reached"]["hostKey"], host_key(4));
        assert_eq!(
            frames[2..],
            [
                json!({"keyResult": {"keyReference": REFERENCE, "stage": "publicKeyInstalled"}}),
                json!({"hostKey": {"keyReference": REFERENCE, "publicKey": host_key(4)}}),
            ]
        );
    }

    #[test]
    fn failed_enrollments_are_bounded_across_launches_and_no_connection_journals_nothing() {
        let temp = guest_root();
        let layout = layout(&temp);
        finish_setup(&layout);
        let mut unreachable = Fake::new(vec![], vec![mine()]);
        let outcome = run(
            &layout,
            euid(),
            &SCHEDULE,
            &mut unreachable,
            &mut Stage("refused", vec![]),
        );
        assert!(matches!(outcome, Outcome::Unreachable(_)), "{outcome:?}");
        assert_eq!(unreachable.connects, SCHEDULE.connects);
        assert_eq!(state_names(&layout), [KEY]);

        // An owner holding another key refuses every proof: three journaled
        // attempts, then nothing more in this or any later launch.
        let mut ends = Vec::new();
        let mut owners = Vec::new();
        for _ in 0..3 {
            let (helper_end, owner_end) = UnixStream::pair().unwrap();
            ends.push(helper_end);
            owners.push(thread::spawn(move || owner(owner_end, [0x01; 32], mine())));
        }
        let mut guest = Fake::new(ends, vec![mine()]);
        let outcome = run(
            &layout,
            euid(),
            &SCHEDULE,
            &mut guest,
            &mut Stage("refused", vec![]),
        );
        for owner in owners {
            assert!(
                owner.join().unwrap().is_err(),
                "the owner verified no proof"
            );
        }
        assert!(
            matches!(outcome, Outcome::AttemptsSpent(Some(_))),
            "{outcome:?}"
        );
        assert_eq!(guest.connects, 3);
        let attempts: Vec<String> = (1..=3).map(attempt_name).collect();
        assert_eq!(
            state_names(&layout),
            [&attempts[..], &[KEY.to_string()]].concat()
        );
        let mut later = Fake::new(vec![], vec![mine()]);
        let outcome = run(
            &layout,
            euid(),
            &SCHEDULE,
            &mut later,
            &mut Stage("refused", vec![]),
        );
        assert!(
            matches!(outcome, Outcome::AttemptsSpent(None)),
            "{outcome:?}"
        );
        assert_eq!(later.connects, 0);
    }
}
