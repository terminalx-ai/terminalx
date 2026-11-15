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
//!
//! The enrollment is made once, but its session can end early: the guest
//! restarts, the person answers after a wait ran out, or the owner's
//! acceptance was lost. A later launch, or the next try of this one, then
//! resumes that enrollment. It proves the seeded key again over a fresh
//! challenge, the owner answers that the proof resumes the enrollment it
//! holds, and the conversation runs again from its start. Nothing is done
//! twice by that: the owner keeps each report it has only if the new one is
//! identical, and the key install returns its own journaled receipt.
//! Resumptions are journaled before they start and bounded across launches,
//! as attempts are. (Before this, a session that ended early left the VM
//! unreachable for good; review 2 of #672.)
//!
//! After the host-key report, only the owner's acknowledgement under the same
//! session, bound to the enrollment's challenge and that exact report, starts
//! retirement (design stage 9, `retire`): the three seeded items as this
//! launch recorded them are removed and the outcome is reported back. A
//! refused, partial or interrupted retirement leaves the remaining items for
//! inspection, and no later launch connects again.
use crate::{
    account,
    child::{self, Installer},
    enroll::{self, Seed, Session},
    fsx::Dir,
    hostkey,
    retire::{self, Acknowledgement, Seeded},
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
    /// Resumptions of this seed's one enrollment, counted across launches.
    pub resumptions: u32,
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
        resumptions: 8,
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
    /// The state directory, seed or seeded items failed their checks;
    /// nothing was attempted.
    Refused(String),
    /// The enrollment was accepted, and every journaled resumption of it
    /// ended without the owner resuming it. Nothing more is tried.
    ResumptionsSpent(Option<String>),
    /// An earlier launch journaled its retirement outcome; nothing more is
    /// done.
    RetirementRecorded,
    /// An earlier retirement started and never journaled its outcome. What
    /// remains is an inspection item; it is never resumed or repeated.
    RetirementInterrupted,
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

/// The state directory, private to `owner` (root in production).
fn open_state(layout: &Layout, owner: u32) -> io::Result<Dir> {
    let state = Dir::open_root(&layout.state())?;
    if state.stat.st_uid != owner || state.stat.st_mode & 0o077 != 0 {
        return Err(refused("the helper state directory is not private to root"));
    }
    Ok(state)
}

/// The seeded record in `state`: one link, private to `owner`, bounded, read
/// once.
fn read_seed(state: &Dir, owner: u32) -> io::Result<Seed> {
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
    Seed::parse(&bytes)
}

/// What an earlier launch's journals already settle, before anything is read
/// or tried. An enrollment alone settles nothing: its session may have ended
/// early, and it is resumed. A retirement that started is never resumed.
fn settled(state: &Dir) -> io::Result<Option<Outcome>> {
    Ok(if state.stat_at(retire::RESULT)?.is_some() {
        Some(Outcome::RetirementRecorded)
    } else if state.stat_at(retire::INTENT)?.is_some() {
        Some(Outcome::RetirementInterrupted)
    } else {
        None
    })
}

/// The challenge digest of the enrollment an earlier connection journaled, if
/// one did. The journal is this helper's own: one private, bounded link.
fn enrolled(state: &Dir, owner: u32) -> io::Result<Option<String>> {
    if state.stat_at(ENROLLED)?.is_none() {
        return Ok(None);
    }
    let (file, stat) = state.open_regular(ENROLLED)?;
    if stat.st_uid != owner || stat.st_mode & 0o077 != 0 || stat.st_nlink != 1 {
        return Err(refused("the enrollment journal is not private to root"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut &file)
        .take(4097)
        .read_to_end(&mut bytes)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| refused("the enrollment journal is not JSON"))?;
    match value["challengeSha256"].as_str() {
        Some(digest)
            if bytes.len() <= 4096
                && value["version"] == 1
                && digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            Ok(Some(digest.to_owned()))
        }
        _ => Err(refused("the enrollment journal is malformed")),
    }
}

fn attempt_name(attempt: u32) -> String {
    format!("enrollment-attempt-{attempt}.json")
}

fn resumption_name(resumption: u32) -> String {
    format!("enrollment-resumption-{resumption}.json")
}

/// A resumed session's own result; the first session's is `RESULT`.
fn result_name(resumption: u32) -> String {
    format!("session-result-{resumption}.json")
}

/// The first unused number in `1..=limit` for the journal `name` gives, or
/// `None` once all are spent.
fn next_unused(state: &Dir, limit: u32, name: fn(u32) -> String) -> io::Result<Option<u32>> {
    for number in 1..=limit {
        if state.stat_at(&name(number))?.is_none() {
            return Ok(Some(number));
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

/// How far a session got.
pub struct Reached {
    /// The confirmed account, key stage and host key.
    pub summary: Value,
    /// The owner's acknowledgement of the final report, when it came.
    pub acknowledgement: Option<Acknowledgement>,
}

/// After the owner's acceptance: reports `accounts`, then follows the owner,
/// each step waiting up to `wait`: the person's confirmation, the key grant
/// installed by `installer` as the confirmed account, and, only after that
/// install, the existing public host key in `ssh_dir` (which, like the key,
/// must belong to `ssh_owner`), followed by the owner's acknowledgement of
/// that report under this session. `challenge_sha256` is the enrollment's
/// challenge, which the acknowledgement names; for a resumed session that is
/// the original one. The session ends at the first refusal.
#[allow(clippy::too_many_arguments)]
pub fn converse(
    session: &mut Session,
    stream: &mut impl Stream,
    challenge_sha256: &str,
    bootstrap_id: &str,
    accounts: &[Value],
    installer: &mut impl Installer,
    ssh_dir: &Path,
    ssh_owner: u32,
    wait: Duration,
) -> io::Result<Reached> {
    session.report_accounts(stream, accounts)?;
    let account = session.await_confirmation(stream, accounts, wait)?;
    let (stage, key_reference) =
        child::grant_and_report(session, stream, &account, bootstrap_id, wait, installer)?;
    let host_key = if stage == "publicKeyInstalled" {
        hostkey::report_host_key(session, stream, &key_reference, ssh_dir, ssh_owner, wait)?
    } else {
        None
    };
    let acknowledgement = match &host_key {
        Some(key) => {
            let report = json!({"hostKey": {"keyReference": key_reference, "publicKey": key}});
            session.set_wait(wait);
            Some(session.receive_acknowledgement(stream, challenge_sha256, &report)?)
        }
        None => None,
    };
    Ok(Reached {
        summary: json!({"confirmed": account.name, "confirmationSha256": account.confirmation_sha256,
            "keyStage": stage, "hostKey": host_key}),
        acknowledgement,
    })
}

/// Retires after `acknowledgement` and tells the owner the stage reached. A
/// retirement that cannot journal its outcome is reported as unknown, never as
/// retired.
fn retire_and_report(
    state: &Dir,
    seeded: &Seeded,
    acknowledgement: &Acknowledgement,
    session: &mut Session,
    stream: &mut impl Stream,
) -> Value {
    let mut outcome = retire::retire(state, seeded, acknowledgement, |_| Ok(()))
        .unwrap_or_else(|error| json!({"stage": "outcomeUnknown", "error": error.to_string()}));
    let stage = outcome["stage"]
        .as_str()
        .unwrap_or("outcomeUnknown")
        .to_owned();
    let report =
        json!({"retirement": {"acknowledgementSha256": acknowledgement.sha256, "stage": stage}});
    outcome["reported"] = json!(session.send(stream, report).is_ok());
    outcome
}

/// One launch. `owner` is the uid that must own the state directory, the
/// seeded items and the SSH directory: root in production.
pub fn run(
    layout: &Layout,
    owner: u32,
    schedule: &Schedule,
    guest: &mut impl Guest,
    installer: &mut impl Installer,
) -> Outcome {
    let state = match open_state(layout, owner) {
        Ok(state) => state,
        Err(error) => return Outcome::Refused(error.to_string()),
    };
    match settled(&state) {
        Ok(None) => {}
        Ok(Some(outcome)) => return outcome,
        Err(error) => return Outcome::Refused(error.to_string()),
    }
    let (seed, seeded) = match read_seed(&state, owner)
        .and_then(|seed| Ok((seed, retire::seeded(&layout.root, owner)?)))
    {
        Ok(found) => found,
        Err(error) => return Outcome::Refused(error.to_string()),
    };
    let mut last_error = None;
    loop {
        match settled(&state) {
            Ok(None) => {}
            Ok(Some(outcome)) => return outcome,
            Err(error) => return Outcome::Refused(error.to_string()),
        }
        // Until an acceptance is journaled this is an enrollment attempt;
        // after it, a resumption of that enrollment. Both are bounded across
        // launches, and each is journaled before its proof is sent.
        let earlier = match enrolled(&state, owner) {
            Ok(earlier) => earlier,
            Err(error) => return Outcome::Refused(error.to_string()),
        };
        let (number, journal, started) = match &earlier {
            None => match next_unused(&state, schedule.attempts, attempt_name) {
                Ok(Some(attempt)) => (
                    attempt,
                    attempt_name(attempt),
                    json!({"attempt": attempt, "version": 1}),
                ),
                Ok(None) => return Outcome::AttemptsSpent(last_error),
                Err(error) => return Outcome::Refused(error.to_string()),
            },
            Some(_) => match next_unused(&state, schedule.resumptions, resumption_name) {
                Ok(Some(resumption)) => (
                    resumption,
                    resumption_name(resumption),
                    json!({"resumption": resumption, "version": 1}),
                ),
                Ok(None) => return Outcome::ResumptionsSpent(last_error),
                Err(error) => return Outcome::Refused(error.to_string()),
            },
        };
        // Nothing to report until the person has finished Setup Assistant.
        while !(layout.setup_done() && !guest.accounts().is_empty()) {
            guest.sleep(schedule.interval);
        }
        let mut stream = match connect(guest, schedule) {
            Ok(stream) => stream,
            Err(failure) => return Outcome::Unreachable(failure),
        };
        if let Err(error) = state.publish_new(&journal, &record(&started)) {
            return Outcome::Refused(error.to_string());
        }
        let enroll::Accepted {
            mut session,
            enrollment: challenge,
            resumed,
        } = match enroll::enroll(&mut stream, &seed, &claims(), schedule.exchange) {
            Ok(accepted) => accepted,
            Err(error) => {
                last_error = Some(error.to_string());
                guest.sleep(schedule.interval);
                continue;
            }
        };
        match &earlier {
            // Accepted: this VM's only enrollment is claimed. When the owner
            // says this proof resumes one, an earlier acceptance was lost on
            // its way here, and that enrollment is the one journaled.
            None => {
                let accepted =
                    json!({"attempt": number, "challengeSha256": challenge, "version": 1});
                if let Err(error) = state.publish_new(ENROLLED, &record(&accepted)) {
                    return Outcome::Refused(error.to_string());
                }
            }
            // The owner resumed exactly the journaled enrollment.
            Some(journaled) if resumed && *journaled == challenge => {}
            // The owner holds another enrollment, or none and took this proof
            // for a new one. This VM's enrollment is not made twice.
            Some(_) => {
                last_error = Some("the owner did not resume this VM's enrollment".into());
                guest.sleep(schedule.interval);
                continue;
            }
        }
        let accounts = guest.accounts();
        let (reached, retirement) = match converse(
            &mut session,
            &mut stream,
            &challenge,
            &seed.bootstrap_id,
            &accounts,
            installer,
            &layout.ssh(),
            owner,
            schedule.person,
        ) {
            Ok(Reached {
                summary,
                acknowledgement: Some(acknowledgement),
            }) => {
                let retirement =
                    retire_and_report(&state, &seeded, &acknowledgement, &mut session, &mut stream);
                (summary, retirement)
            }
            Ok(Reached { summary, .. }) => (summary, Value::Null),
            Err(error) => (json!({"error": error.to_string()}), Value::Null),
        };
        let mut result = json!({"challengeSha256": challenge, "reached": reached,
            "retirement": retirement, "version": 1});
        let name = match &earlier {
            None => RESULT.to_owned(),
            Some(_) => {
                result["resumption"] = json!(number);
                result_name(number)
            }
        };
        return match state.publish_new(&name, &record(&result)) {
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
        resumptions: 2,
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
        for item in &crate::seed::PRODUCTION.items[..2] {
            let dir = layout.path(item.dirs);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(item.name), item.key).unwrap();
            private(&dir.join(item.name), item.mode.into());
        }
        std::fs::write(
            layout.path(&["Library", "LaunchDaemons", "neighbour.plist"]),
            b"not seeded",
        )
        .unwrap();
        std::fs::create_dir_all(layout.ssh()).unwrap();
        for dir in walk_dirs(temp.path()) {
            if dir != layout.state() {
                private(&dir, 0o755);
            }
        }
        temp
    }

    /// Every directory under `root`, so fixtures can give them the seeded modes.
    fn walk_dirs(root: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if std::fs::symlink_metadata(&path).unwrap().is_dir() {
                found.extend(walk_dirs(&path));
                found.push(path);
            }
        }
        found
    }

    /// Which of the seeded plist, program and key are still present.
    fn seeded_present(layout: &Layout) -> Vec<bool> {
        crate::seed::PRODUCTION
            .items
            .iter()
            .map(|item| std::fs::symlink_metadata(layout.path(item.dirs).join(item.name)).is_ok())
            .collect()
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
    fn owner(end: UnixStream, key: [u8; 32], account: Value, ack: Ack) -> io::Result<Vec<Value>> {
        owner_answering(end, key, account, ack, enroll::Reply::Accept).map(|(_, frames)| frames)
    }

    /// As `owner`, answering the verified proof with `reply`. Also returns
    /// the digest of the challenge this connection's proof answered. A
    /// resumed session's acknowledgement names the enrollment it resumes, as
    /// the real owner's does.
    fn owner_answering(
        mut end: UnixStream,
        key: [u8; 32],
        account: Value,
        ack: Ack,
        reply: enroll::Reply,
    ) -> Served {
        let deadline = || Instant::now() + Duration::from_secs(3);
        let (proof, session) = enroll::accept_fixture_with(&mut end, key, |_| {}, reply.clone())?;
        let challenge = proof["challengeSha256"].as_str().unwrap().to_owned();
        let enrollment = match &reply {
            enroll::Reply::Resume(enrollment) => enrollment.clone(),
            enroll::Reply::Lost => return Ok((challenge, vec![])),
            _ => challenge.clone(),
        };
        let frames = (|| -> io::Result<Vec<Value>> {
            let mut frames = vec![Session::helper_body(
                &session,
                0,
                &read_frame(&mut end, deadline())?,
            )?];
            if let Ack::HangUp = ack {
                return Ok(frames);
            }
            let acknowledgement = |final_report: &Value| {
                json!({"retire": {"challengeSha256": enrollment,
                "hostKeySha256": crate::sha256(&record(final_report)), "observationSha256": "b".repeat(64)}})
            };
            if let Ack::Premature = ack {
                let early = acknowledgement(
                    &json!({"hostKey": {"keyReference": REFERENCE, "publicKey": host_key(4)}}),
                );
                write_frame(
                    &mut end,
                    &Session::owner_frame(&session, 1, &early),
                    deadline(),
                )?;
                while let Ok(frame) = read_frame(&mut end, deadline()) {
                    frames.push(Session::helper_body(&session, frames.len() as u64, &frame)?);
                }
                return Ok(frames);
            }
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
                let body = Session::helper_body(&session, seq, &frame)?;
                seq += 1;
                frames.push(body.clone());
                if body.get("hostKey").is_none() {
                    continue;
                }
                let mut sent = acknowledgement(&body);
                let signer = match ack {
                    Ack::Never => break,
                    Ack::Changed(change) => {
                        change(&mut sent);
                        session
                    }
                    Ack::Untagged => [0x02; 32],
                    _ => session,
                };
                write_frame(
                    &mut end,
                    &Session::owner_frame(&signer, 3, &sent),
                    deadline(),
                )?;
            }
            Ok(frames)
        })()?;
        Ok((challenge, frames))
    }

    /// How the fixture owner answers the helper's host-key report.
    #[derive(Clone, Copy)]
    enum Ack {
        /// Closes the session without acknowledging.
        Never,
        /// Acknowledges exactly, as the real owner does.
        Exact,
        /// Acknowledges with `change` applied to the body.
        Changed(fn(&mut Value)),
        /// Tags the acknowledgement under another session key.
        Untagged,
        /// Sends an acknowledgement in place of the person's confirmation.
        Premature,
        /// Closes the session after the helper's account report, as an owner
        /// whose session ended early does.
        HangUp,
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
        let cases: [(&str, Change); 7] = [
            ("no state", |l| std::fs::remove_dir_all(l.state()).unwrap()),
            ("unseeded program", |l| {
                std::fs::remove_file(
                    l.path(crate::seed::PRODUCTION.items[1].dirs)
                        .join("terminalx-vm-bootstrap"),
                )
                .unwrap()
            }),
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
        let owner = thread::spawn(move || owner(owner_end, SEEDED, mine(), Ack::Never));
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

        // A later launch makes no second enrollment. It tries to resume this
        // one, and with no owner listening it journals nothing.
        let before = state_names(&layout);
        let mut again = Fake::new(vec![], vec![mine()]);
        let outcome = run(
            &layout,
            euid(),
            &SCHEDULE,
            &mut again,
            &mut Stage("publicKeyInstalled", vec![]),
        );
        assert!(matches!(outcome, Outcome::Unreachable(_)), "{outcome:?}");
        assert_eq!(again.connects, SCHEDULE.connects);
        assert_eq!(state_names(&layout), before);
    }

    fn with_host_key(layout: &Layout) {
        finish_setup(layout);
        std::fs::write(
            layout.ssh().join(hostkey::HOST_KEY),
            format!("{} root@guest\n", host_key(4)),
        )
        .unwrap();
        private(&layout.ssh().join(hostkey::HOST_KEY), 0o644);
    }

    /// One launch against the fixture owner answering with `ack`.
    fn session(layout: &Layout, ack: Ack, installer: &mut impl Installer) -> (Outcome, Vec<Value>) {
        let (helper_end, owner_end) = UnixStream::pair().unwrap();
        let owner = thread::spawn(move || owner(owner_end, SEEDED, mine(), ack));
        let outcome = run(
            layout,
            euid(),
            &SCHEDULE,
            &mut Fake::new(vec![helper_end], vec![mine()]),
            installer,
        );
        (outcome, owner.join().unwrap().unwrap())
    }

    #[test]
    fn after_its_host_key_report_the_owners_acknowledgement_retires_exactly_the_seeded_items() {
        let temp = guest_root();
        let layout = layout(&temp);
        with_host_key(&layout);
        let mut installer = Stage("publicKeyInstalled", vec![]);
        let (outcome, frames) = session(&layout, Ack::Exact, &mut installer);
        let Outcome::Finished(result) = outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(
            installer.1,
            vec![format!("{}:{REFERENCE}", mine()["name"].as_str().unwrap())]
        );
        assert_eq!(result["reached"]["keyStage"], "publicKeyInstalled");
        assert_eq!(result["reached"]["hostKey"], host_key(4));
        let retirement = &result["retirement"];
        assert_eq!(
            (
                retirement["stage"].as_str(),
                retirement["reported"].as_bool()
            ),
            (Some("retired"), Some(true))
        );
        assert_eq!(retirement["removed"], json!(["key", "plist", "program"]));
        let host_key_report =
            json!({"hostKey": {"keyReference": REFERENCE, "publicKey": host_key(4)}});
        assert_eq!(
            frames[2..],
            [
                json!({"keyResult": {"keyReference": REFERENCE, "stage": "publicKeyInstalled"}}),
                host_key_report.clone(),
                json!({"retirement": {"acknowledgementSha256": retirement["acknowledgementSha256"], "stage": "retired"}}),
            ]
        );
        assert_eq!(seeded_present(&layout), [false, false, false]);
        assert!(layout
            .path(&["Library", "LaunchDaemons", "neighbour.plist"])
            .exists());
        assert!(
            layout.ssh().join(hostkey::HOST_KEY).exists(),
            "the host key is never touched"
        );
        let names = state_names(&layout);
        for name in [ENROLLED, RESULT, retire::INTENT, retire::RESULT] {
            assert!(names.iter().any(|n| n == name), "{name} in {names:?}");
        }
        let mut later = Fake::new(vec![], vec![mine()]);
        let again = run(
            &layout,
            euid(),
            &SCHEDULE,
            &mut later,
            &mut Stage("publicKeyInstalled", vec![]),
        );
        assert!(matches!(again, Outcome::RetirementRecorded), "{again:?}");
        assert_eq!(later.connects, 0);
    }

    #[test]
    fn a_missing_changed_untagged_or_premature_acknowledgement_removes_nothing() {
        let cases: [(&str, Ack); 6] = [
            ("never", Ack::Never),
            (
                "another session",
                Ack::Changed(|b| b["retire"]["challengeSha256"] = json!("c".repeat(64))),
            ),
            (
                "another report",
                Ack::Changed(|b| b["retire"]["hostKeySha256"] = json!("d".repeat(64))),
            ),
            (
                "extra field",
                Ack::Changed(|b| b["retire"]["also"] = json!(true)),
            ),
            ("untagged", Ack::Untagged),
            ("premature", Ack::Premature),
        ];
        for (name, ack) in cases {
            let temp = guest_root();
            let layout = layout(&temp);
            with_host_key(&layout);
            let (outcome, frames) = session(&layout, ack, &mut Stage("publicKeyInstalled", vec![]));
            let Outcome::Finished(result) = outcome else {
                panic!("{name}: {outcome:?}")
            };
            assert!(result["reached"]["error"].is_string(), "{name}: {result}");
            assert_eq!(result["retirement"], Value::Null, "{name}");
            assert_eq!(seeded_present(&layout), [true, true, true], "{name}");
            assert!(
                !state_names(&layout).iter().any(|n| n == retire::INTENT),
                "{name}"
            );
            assert!(
                !frames.iter().any(|f| f.get("retirement").is_some()),
                "{name}"
            );
            let mut later = Fake::new(vec![], vec![mine()]);
            let again = run(
                &layout,
                euid(),
                &SCHEDULE,
                &mut later,
                &mut Stage("publicKeyInstalled", vec![]),
            );
            // Nothing was removed, so the enrollment can still be resumed;
            // with no owner listening nothing more is journaled.
            assert!(
                matches!(again, Outcome::Unreachable(_)),
                "{name}: {again:?}"
            );
            assert_eq!(later.connects, SCHEDULE.connects, "{name}");
            assert!(
                !state_names(&layout)
                    .iter()
                    .any(|n| n.starts_with("enrollment-resumption-")),
                "{name}"
            );
        }
    }

    /// Replaces the seeded program during the session, then reports an install.
    struct Substitutes(PathBuf);

    impl Installer for Substitutes {
        fn install(&mut self, _: &ConfirmedAccount, _: &KeyGrant) -> String {
            std::fs::remove_file(&self.0).unwrap();
            std::fs::write(&self.0, b"another program").unwrap();
            private(&self.0, 0o755);
            "publicKeyInstalled".into()
        }
    }

    #[test]
    fn a_seeded_item_changed_after_launch_or_an_interrupted_retirement_is_left_for_inspection() {
        {
            let temp = guest_root();
            let layout = layout(&temp);
            with_host_key(&layout);
            let program = layout
                .path(crate::seed::PRODUCTION.items[1].dirs)
                .join("terminalx-vm-bootstrap");
            let (outcome, frames) = session(&layout, Ack::Exact, &mut Substitutes(program));
            let Outcome::Finished(result) = outcome else {
                panic!("{outcome:?}")
            };
            assert_eq!(result["retirement"]["stage"], "refused");
            assert_eq!(result["retirement"]["removed"], json!([]));
            assert_eq!(seeded_present(&layout), [true, true, true]);
            assert_eq!(frames.last().unwrap()["retirement"]["stage"], "refused");
            let mut later = Fake::new(vec![], vec![mine()]);
            let again = run(
                &layout,
                euid(),
                &SCHEDULE,
                &mut later,
                &mut Stage("publicKeyInstalled", vec![]),
            );
            assert!(matches!(again, Outcome::RetirementRecorded), "{again:?}");
        }

        {
            // An intent without an outcome, as a crash leaves it: never resumed.
            let temp = guest_root();
            let layout = layout(&temp);
            finish_setup(&layout);
            std::fs::write(layout.state().join(retire::INTENT), b"{}").unwrap();
            let mut later = Fake::new(vec![], vec![mine()]);
            let outcome = run(
                &layout,
                euid(),
                &SCHEDULE,
                &mut later,
                &mut Stage("publicKeyInstalled", vec![]),
            );
            assert!(
                matches!(outcome, Outcome::RetirementInterrupted),
                "{outcome:?}"
            );
            assert_eq!(
                (later.connects, seeded_present(&layout)),
                (0, vec![true, true, true])
            );
        }
    }

    /// What one fixture owner saw: the digest of the challenge its
    /// connection's proof answered, and the helper's frames.
    type Served = io::Result<(String, Vec<Value>)>;

    /// One launch against a fixture owner on each of `owners`' connections,
    /// in order.
    fn launch(
        layout: &Layout,
        owners: Vec<(Ack, enroll::Reply)>,
        installer: &mut impl Installer,
    ) -> (Outcome, Vec<Served>) {
        let mut ends = Vec::new();
        let mut threads = Vec::new();
        for (ack, reply) in owners {
            let (helper_end, owner_end) = UnixStream::pair().unwrap();
            ends.push(helper_end);
            threads.push(thread::spawn(move || {
                owner_answering(owner_end, SEEDED, mine(), ack, reply)
            }));
        }
        // `Fake` hands out its connections last first.
        ends.reverse();
        let outcome = run(
            layout,
            euid(),
            &SCHEDULE,
            &mut Fake::new(ends, vec![mine()]),
            installer,
        );
        (
            outcome,
            threads.into_iter().map(|t| t.join().unwrap()).collect(),
        )
    }

    fn journal(layout: &Layout, name: &str) -> Value {
        serde_json::from_slice(&std::fs::read(layout.state().join(name)).unwrap()).unwrap()
    }

    #[test]
    fn a_session_that_ended_early_is_resumed_by_a_later_launch_under_the_same_enrollment() {
        let temp = guest_root();
        let layout = layout(&temp);
        with_host_key(&layout);
        // The owner's session ends after the account report: the guest
        // restarted, or the person had not answered when the wait ran out.
        let mut installer = Stage("publicKeyInstalled", vec![]);
        let (outcome, owners) = launch(
            &layout,
            vec![(Ack::HangUp, enroll::Reply::Accept)],
            &mut installer,
        );
        let (enrollment, frames) = owners[0].as_ref().unwrap();
        assert_eq!(frames, &vec![json!({"accounts": [mine()]})]);
        let Outcome::Finished(first) = outcome else {
            panic!("{outcome:?}")
        };
        assert!(first["reached"]["error"].is_string(), "{first}");
        assert_eq!(first["challengeSha256"], enrollment.as_str());
        assert!(installer.1.is_empty(), "no grant was reached");
        assert_eq!(
            state_names(&layout),
            [ENROLLED, "enrollment-attempt-1.json", KEY, RESULT]
        );
        let enrolled_record = std::fs::read(layout.state().join(ENROLLED)).unwrap();

        // The next launch proves the key again. The owner answers that this
        // resumes the enrollment it holds, and the conversation runs through.
        let (outcome, owners) = launch(
            &layout,
            vec![(Ack::Exact, enroll::Reply::Resume(enrollment.clone()))],
            &mut installer,
        );
        let (resumed_challenge, frames) = owners[0].as_ref().unwrap();
        assert_ne!(resumed_challenge, enrollment, "a fresh challenge each time");
        let Outcome::Finished(result) = outcome else {
            panic!("{outcome:?}")
        };
        // The session is the enrollment's: its result and the acknowledgement
        // it retired on name the original challenge, not this connection's.
        assert_eq!(result["challengeSha256"], enrollment.as_str());
        assert_eq!(result["resumption"], 1);
        assert_eq!(result["reached"]["keyStage"], "publicKeyInstalled");
        assert_eq!(result["retirement"]["stage"], "retired");
        assert_eq!(frames[0], json!({"accounts": [mine()]}), "reported again");
        assert_eq!(frames.last().unwrap()["retirement"]["stage"], "retired");
        assert_eq!(installer.1.len(), 1, "one grant, in the resumed session");
        assert_eq!(seeded_present(&layout), [false, false, false]);
        // No second enrollment: the journal is the original, and the resumed
        // session has its own journals beside the first session's.
        assert_eq!(
            std::fs::read(layout.state().join(ENROLLED)).unwrap(),
            enrolled_record
        );
        assert_eq!(journal(&layout, RESULT), first);
        assert_eq!(journal(&layout, "session-result-1.json"), result);
        assert_eq!(
            journal(&layout, "enrollment-resumption-1.json"),
            json!({"resumption": 1, "version": 1})
        );
        assert!(!layout.state().join("enrollment-attempt-2.json").exists());
        let secret = [STANDARD.encode(SEEDED), crate::hex(&SEEDED)];
        for name in state_names(&layout) {
            let text = std::fs::read_to_string(layout.state().join(&name)).unwrap();
            assert!(
                name == KEY || !secret.iter().any(|s| text.contains(s.as_str())),
                "{name} names the key"
            );
        }
    }

    #[test]
    fn a_lost_acceptance_is_resumed_and_the_owners_enrollment_is_the_one_journaled() {
        let temp = guest_root();
        let layout = layout(&temp);
        with_host_key(&layout);
        // The owner verified the first proof and claimed the enrollment, but
        // its acceptance never arrived. The helper's next attempt is, to the
        // owner, a resumption of that enrollment.
        let (lost_end, lost_owner_end) = UnixStream::pair().unwrap();
        let lost = thread::spawn(move || {
            owner_answering(
                lost_owner_end,
                SEEDED,
                mine(),
                Ack::Exact,
                enroll::Reply::Lost,
            )
        });
        let (resume_end, resume_owner_end) = UnixStream::pair().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel::<String>();
        let resume = thread::spawn(move || {
            let enrollment = receiver.recv().unwrap();
            owner_answering(
                resume_owner_end,
                SEEDED,
                mine(),
                Ack::Exact,
                enroll::Reply::Resume(enrollment),
            )
        });
        let claimed = thread::spawn(move || {
            let (enrollment, frames) = lost.join().unwrap().unwrap();
            assert!(frames.is_empty());
            sender.send(enrollment.clone()).unwrap();
            enrollment
        });
        let mut installer = Stage("publicKeyInstalled", vec![]);
        let outcome = run(
            &layout,
            euid(),
            &SCHEDULE,
            &mut Fake::new(vec![resume_end, lost_end], vec![mine()]),
            &mut installer,
        );
        let enrollment = claimed.join().unwrap();
        let (_, frames) = resume.join().unwrap().unwrap();
        let Outcome::Finished(result) = outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(result["challengeSha256"], enrollment.as_str());
        assert_eq!(result["retirement"]["stage"], "retired");
        assert_eq!(frames.last().unwrap()["retirement"]["stage"], "retired");
        // Two attempts were journaled, and the enrollment journaled is the one
        // the owner claimed on the first: it was never made twice.
        assert_eq!(
            journal(&layout, ENROLLED),
            json!({"attempt": 2, "challengeSha256": enrollment, "version": 1})
        );
        assert_eq!(journal(&layout, RESULT), result);
        let names = state_names(&layout);
        for name in ["enrollment-attempt-1.json", "enrollment-attempt-2.json"] {
            assert!(names.iter().any(|n| n == name), "{name} in {names:?}");
        }
        assert!(
            !names
                .iter()
                .any(|n| n.starts_with("enrollment-resumption-")),
            "{names:?}"
        );
    }

    #[test]
    fn only_the_journaled_enrollment_is_resumed_and_resumptions_are_bounded_across_launches() {
        let temp = guest_root();
        let layout = layout(&temp);
        with_host_key(&layout);
        let mut installer = Stage("publicKeyInstalled", vec![]);
        let (_, owners) = launch(
            &layout,
            vec![(Ack::HangUp, enroll::Reply::Accept)],
            &mut installer,
        );
        let enrollment = owners[0].as_ref().unwrap().0.clone();
        let before = std::fs::read(layout.state().join(ENROLLED)).unwrap();

        // An owner that resumes some other enrollment, and one that holds none
        // and takes the proof for a new enrollment: neither is followed. The
        // helper reports nothing to them, and each try spends a resumption.
        let (outcome, owners) = launch(
            &layout,
            vec![
                (Ack::Exact, enroll::Reply::Resume("e".repeat(64))),
                (Ack::Exact, enroll::Reply::Accept),
            ],
            &mut installer,
        );
        assert!(
            matches!(&outcome, Outcome::ResumptionsSpent(Some(reason)) if reason.contains("did not resume")),
            "{outcome:?}"
        );
        for owner in owners {
            assert!(
                owner.is_err(),
                "the helper closed without a report: {owner:?}"
            );
        }
        assert!(installer.1.is_empty());
        assert_eq!(seeded_present(&layout), [true, true, true]);
        assert_eq!(
            std::fs::read(layout.state().join(ENROLLED)).unwrap(),
            before
        );
        assert_eq!(
            state_names(&layout),
            [
                ENROLLED,
                "enrollment-attempt-1.json",
                "enrollment-resumption-1.json",
                "enrollment-resumption-2.json",
                KEY,
                RESULT
            ]
        );

        // Spent: no later launch connects, even to the owner that would resume it.
        let (helper_end, owner_end) = UnixStream::pair().unwrap();
        let mut later = Fake::new(vec![helper_end], vec![mine()]);
        let outcome = run(&layout, euid(), &SCHEDULE, &mut later, &mut installer);
        assert!(
            matches!(outcome, Outcome::ResumptionsSpent(None)),
            "{outcome:?}"
        );
        assert_eq!(later.connects, 0);
        drop(owner_end);
        let _ = enrollment;

        // A damaged or foreign enrollment journal is never followed either.
        let damaged = guest_root();
        let layout = Layout {
            root: damaged.path().to_path_buf(),
        };
        finish_setup(&layout);
        for (name, bytes) in [
            ("not JSON", &b"{"[..]),
            ("no digest", &br#"{"attempt":1,"version":1}"#[..]),
            (
                "short digest",
                &br#"{"attempt":1,"challengeSha256":"abcd","version":1}"#[..],
            ),
            (
                "another version",
                format!(
                    r#"{{"attempt":1,"challengeSha256":"{}","version":2}}"#,
                    "a".repeat(64)
                )
                .as_bytes(),
            ),
        ] {
            std::fs::write(layout.state().join(ENROLLED), bytes).unwrap();
            private(&layout.state().join(ENROLLED), 0o600);
            let mut guest = Fake::new(vec![], vec![mine()]);
            let outcome = run(&layout, euid(), &SCHEDULE, &mut guest, &mut installer);
            assert!(
                matches!(outcome, Outcome::Refused(_)),
                "{name}: {outcome:?}"
            );
            assert_eq!(guest.connects, 0, "{name}");
        }
        std::fs::write(
            layout.state().join(ENROLLED),
            format!(
                r#"{{"attempt":1,"challengeSha256":"{}","version":1}}"#,
                "a".repeat(64)
            ),
        )
        .unwrap();
        private(&layout.state().join(ENROLLED), 0o644);
        let mut guest = Fake::new(vec![], vec![mine()]);
        let outcome = run(&layout, euid(), &SCHEDULE, &mut guest, &mut installer);
        assert!(
            matches!(outcome, Outcome::Refused(_)),
            "readable journal: {outcome:?}"
        );
        assert_eq!(guest.connects, 0);
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
            owners.push(thread::spawn(move || {
                owner(owner_end, [0x01; 32], mine(), Ack::Never)
            }));
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
