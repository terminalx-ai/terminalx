//! Design slice 3, guest side: the account the person confirmed in TerminalX,
//! and the privilege drop to it. A `ConfirmedAccount` exists only when the
//! owner sends a confirmation over a verified enrollment session, so guest
//! root holding the key never by itself selects or consents to an account.
//! The account's files are only ever touched after `drop_to` has made this
//! process that account, with no way back to root.
use crate::enroll::Session;
use crate::wire::Stream;
use serde_json::{Map, Value};
use std::{ffi::CString, io};

fn refused(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason.into())
}

/// A local account the person confirmed for this VM. No public constructor.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ConfirmedAccount {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
    pub home_device: u64,
    pub home_inode: u64,
    /// Digest of the host's confirmation record (parent session, tab, request).
    pub confirmation_sha256: String,
}

fn short_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-' || *b == b'.'
        })
}

impl ConfirmedAccount {
    #[cfg(test)]
    pub(crate) fn fixture(
        name: &str,
        uid: u32,
        gid: u32,
        home: &str,
        home_device: u64,
        home_inode: u64,
    ) -> ConfirmedAccount {
        ConfirmedAccount {
            name: name.into(),
            uid,
            gid,
            home: home.into(),
            home_device,
            home_inode,
            confirmation_sha256: "c".repeat(64),
        }
    }
    /// Exactly `{accountConfirmation: {confirmed: true, confirmationSha256, gid,
    /// home, homeDevice, homeInode, name, uid}}`, a personal account (UID ≥ 501,
    /// non-wheel group, `/Users/<name>`).
    pub(crate) fn from_body(body: &Value) -> io::Result<ConfirmedAccount> {
        let outer = body
            .as_object()
            .filter(|o| o.len() == 1)
            .ok_or_else(|| refused("not an account confirmation"))?;
        let inner: &Map<String, Value> = outer
            .get("accountConfirmation")
            .and_then(Value::as_object)
            .ok_or_else(|| refused("not an account confirmation"))?;
        let mut keys: Vec<&str> = inner.keys().map(String::as_str).collect();
        keys.sort_unstable();
        if keys
            != [
                "confirmationSha256",
                "confirmed",
                "gid",
                "home",
                "homeDevice",
                "homeInode",
                "name",
                "uid",
            ]
            || inner["confirmed"] != true
        {
            return Err(refused("the person has not confirmed this account"));
        }
        let number = |k: &str| {
            inner[k]
                .as_u64()
                .ok_or_else(|| refused(format!("{k} is not a number")))
        };
        let text = |k: &str| {
            inner[k]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| refused(format!("{k} is not text")))
        };
        let account = ConfirmedAccount {
            name: text("name")?,
            uid: u32::try_from(number("uid")?).map_err(|_| refused("uid"))?,
            gid: u32::try_from(number("gid")?).map_err(|_| refused("gid"))?,
            home: text("home")?,
            home_device: number("homeDevice")?,
            home_inode: number("homeInode")?,
            confirmation_sha256: text("confirmationSha256")?,
        };
        let digest_ok = account.confirmation_sha256.len() == 64
            && account
                .confirmation_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !short_name(&account.name)
            || account.uid < 501
            || account.gid == 0
            || account.home != format!("/Users/{}", account.name)
            || account.home_inode == 0
            || !digest_ok
        {
            return Err(refused("confirmation does not name a personal account"));
        }
        Ok(account)
    }

    /// The local account database and home directory still match what the
    /// person confirmed: same name, ids, home path and home device/inode.
    pub fn check_local(&self) -> io::Result<()> {
        let name = CString::new(self.name.as_str()).map_err(|_| refused("name"))?;
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut buffer = vec![0 as libc::c_char; 16 * 1024];
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: valid name, entry storage, buffer and out-pointer for the call.
        let code = unsafe {
            libc::getpwnam_r(
                name.as_ptr(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut found,
            )
        };
        if code != 0 || found.is_null() {
            return Err(refused("the confirmed account no longer exists"));
        }
        // SAFETY: getpwnam_r succeeded and filled entry, whose strings live in buffer.
        let entry = unsafe { entry.assume_init() };
        // SAFETY: pw_dir is a NUL-terminated string inside buffer.
        let home = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }
            .to_string_lossy()
            .into_owned();
        let meta = std::fs::symlink_metadata(&self.home)?;
        use std::os::unix::fs::MetadataExt;
        if entry.pw_uid != self.uid
            || entry.pw_gid != self.gid
            || home != self.home
            || !meta.is_dir()
            || meta.uid() != self.uid
            || meta.dev() != self.home_device
            || meta.ino() != self.home_inode
        {
            return Err(refused(
                "the local account or home changed since it was confirmed",
            ));
        }
        Ok(())
    }
}

/// One personal account as the helper reports it, or `None` when it is not a
/// personal account with its own `/Users/<name>` home directory.
pub fn describe(name: &str, uid: u32, gid: u32, home: &str) -> Option<Value> {
    use std::os::unix::fs::MetadataExt;
    if !short_name(name)
        || !(501..65534).contains(&uid)
        || gid == 0
        || home != format!("/Users/{name}")
    {
        return None;
    }
    let meta = std::fs::symlink_metadata(home).ok()?;
    (meta.is_dir() && meta.uid() == uid).then(|| {
        serde_json::json!({"gid": gid, "home": home, "homeDevice": meta.dev(), "homeInode": meta.ino(), "name": name, "uid": uid})
    })
}

/// The local personal accounts, sorted by uid and bounded. Observations only:
/// the person, not this helper, chooses which one TerminalX may use.
pub fn observe() -> Vec<Value> {
    let mut accounts = Vec::new();
    // SAFETY: the account database iterator is used from this one thread and
    // each entry's strings are copied before the next call.
    unsafe {
        libc::setpwent();
        loop {
            let entry = libc::getpwent();
            if entry.is_null() || accounts.len() >= 64 {
                break;
            }
            let text =
                |p: *const libc::c_char| std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned();
            let (name, home) = (text((*entry).pw_name), text((*entry).pw_dir));
            if let Some(account) = describe(&name, (*entry).pw_uid, (*entry).pw_gid, &home) {
                accounts.push(account);
            }
        }
        libc::endpwent();
    }
    accounts.sort_by_key(|a| a["uid"].as_u64());
    accounts.dedup();
    accounts.truncate(16);
    accounts
}

impl Session {
    /// The only way to obtain a `ConfirmedAccount`: the next owner frame, tagged
    /// under this verified session, carrying the person's confirmation.
    pub fn receive_confirmation(
        &mut self,
        stream: &mut impl Stream,
    ) -> io::Result<ConfirmedAccount> {
        ConfirmedAccount::from_body(&self.receive(stream)?)
    }

    /// Reports the observed accounts for the person to choose from.
    pub fn report_accounts(
        &mut self,
        stream: &mut impl Stream,
        accounts: &[Value],
    ) -> io::Result<()> {
        self.send(stream, serde_json::json!({"accounts": accounts}))
    }

    /// Waits up to `wait` for the person's confirmation. It is accepted only for
    /// exactly one of the accounts this helper reported, and only while the
    /// local account still matches; the owner is told either way.
    pub fn await_confirmation(
        &mut self,
        stream: &mut impl Stream,
        reported: &[Value],
        wait: std::time::Duration,
    ) -> io::Result<ConfirmedAccount> {
        self.set_wait(wait);
        let account = self.receive_confirmation(stream)?;
        let observed = serde_json::json!({"gid": account.gid, "home": account.home, "homeDevice": account.home_device,
            "homeInode": account.home_inode, "name": account.name, "uid": account.uid});
        let checked = if reported.contains(&observed) {
            account.check_local()
        } else {
            Err(refused(
                "the confirmation names an account this helper did not report",
            ))
        };
        let digest = account.confirmation_sha256.clone();
        match checked {
            Ok(()) => {
                self.send(
                    stream,
                    serde_json::json!({"accountConfirmed": {"confirmationSha256": digest}}),
                )?;
                Ok(account)
            }
            Err(error) => {
                self.send(stream, serde_json::json!({"accountRefused": {"confirmationSha256": digest, "reason": error.to_string()}}))?;
                Err(error)
            }
        }
    }
}

/// Process ids as the kernel reports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ids {
    pub uid: u32,
    pub euid: u32,
    pub gid: u32,
    pub egid: u32,
}

pub fn ids() -> Ids {
    // SAFETY: these calls have no preconditions and cannot fail.
    unsafe {
        Ids {
            uid: libc::getuid(),
            euid: libc::geteuid(),
            gid: libc::getgid(),
            egid: libc::getegid(),
        }
    }
}

/// After a drop, every real and effective id is the account's and root
/// cannot be regained.
pub fn verify_dropped(
    after: Ids,
    account: &ConfirmedAccount,
    regained_root: bool,
) -> io::Result<()> {
    if after
        != (Ids {
            uid: account.uid,
            euid: account.uid,
            gid: account.gid,
            egid: account.gid,
        })
        || regained_root
    {
        return Err(refused("privileges were not fully and permanently dropped"));
    }
    Ok(())
}

/// Drops this process (meant to be a freshly forked child of the root helper)
/// to the confirmed account: supplementary groups, then group, then user. It
/// refuses unless it starts as root and the local account still matches.
pub fn drop_to(account: &ConfirmedAccount) -> io::Result<Dropped> {
    if ids().euid != 0 {
        return Err(refused(
            "the account child must start as root to drop privileges",
        ));
    }
    account.check_local()?;
    let name = CString::new(account.name.as_str()).map_err(|_| refused("name"))?;
    // SAFETY: valid name and ids; each call is checked before the next.
    unsafe {
        if libc::initgroups(name.as_ptr(), account.gid as libc::c_int) != 0
            || libc::setgid(account.gid) != 0
            || libc::setuid(account.uid) != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: probing that root cannot be regained; success is a failure.
    let regained = unsafe { libc::setuid(0) } == 0;
    verify_dropped(ids(), account, regained)?;
    Ok(Dropped {
        account: account.clone(),
    })
}

/// Proof that this process is now the confirmed account, permanently. Only
/// `drop_to` makes one, so account files are reachable only after the drop.
#[derive(Debug)]
pub struct Dropped {
    account: ConfirmedAccount,
}

impl Dropped {
    pub fn account(&self) -> &ConfirmedAccount {
        &self.account
    }
    #[cfg(test)]
    pub(crate) fn fixture(account: ConfirmedAccount) -> Dropped {
        Dropped { account }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::MetadataExt;

    fn me() -> Value {
        let user = std::env::var("USER").unwrap();
        let home = format!("/Users/{user}");
        let meta = std::fs::metadata(&home).unwrap();
        let now = ids();
        json!({"accountConfirmation": {"confirmed": true, "confirmationSha256": "c".repeat(64), "gid": now.gid,
            "home": home, "homeDevice": meta.dev(), "homeInode": meta.ino(), "name": user, "uid": now.uid}})
    }

    #[test]
    fn a_confirmation_names_one_personal_account_exactly() {
        let account = ConfirmedAccount::from_body(&me()).unwrap();
        assert_eq!(account.uid, ids().uid);
        type Change = fn(&mut Value);
        let changes: [Change; 9] = [
            |b| b["accountConfirmation"]["confirmed"] = json!(false),
            |b| b["accountConfirmation"]["uid"] = json!(0),
            |b| b["accountConfirmation"]["uid"] = json!(499),
            |b| b["accountConfirmation"]["gid"] = json!(0),
            |b| b["accountConfirmation"]["home"] = json!("/var/root"),
            |b| b["accountConfirmation"]["name"] = json!("../x"),
            |b| b["accountConfirmation"]["confirmationSha256"] = json!("C".repeat(64)),
            |b| b["accountConfirmation"]["extra"] = json!(1),
            |b| b["other"] = json!(1),
        ];
        for change in changes {
            let mut body = me();
            change(&mut body);
            assert!(ConfirmedAccount::from_body(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn the_local_account_and_home_must_still_match() {
        let account = ConfirmedAccount::from_body(&me()).unwrap();
        account.check_local().unwrap();
        for change in [
            |a: &mut ConfirmedAccount| a.uid += 1,
            |a: &mut ConfirmedAccount| a.gid += 1,
            |a: &mut ConfirmedAccount| a.home_inode += 1,
            |a: &mut ConfirmedAccount| a.home_device += 1,
            |a: &mut ConfirmedAccount| a.name = "nosuchaccountx".into(),
        ] {
            let mut changed = account.clone();
            change(&mut changed);
            assert!(changed.check_local().is_err(), "{changed:?}");
        }
    }

    #[test]
    fn dropping_requires_root_and_never_changes_ids_otherwise() {
        if ids().euid == 0 {
            return; // this fixture is the unprivileged refusal path only
        }
        let before = ids();
        let account = ConfirmedAccount::from_body(&me()).unwrap();
        assert!(drop_to(&account)
            .unwrap_err()
            .to_string()
            .contains("start as root"));
        assert_eq!(ids(), before);
    }

    #[test]
    fn a_partial_or_reversible_drop_is_refused() {
        let account = ConfirmedAccount::from_body(&me()).unwrap();
        let exact = Ids {
            uid: account.uid,
            euid: account.uid,
            gid: account.gid,
            egid: account.gid,
        };
        assert!(verify_dropped(exact, &account, false).is_ok());
        assert!(
            verify_dropped(exact, &account, true).is_err(),
            "root regained"
        );
        assert!(verify_dropped(Ids { euid: 0, ..exact }, &account, false).is_err());
        assert!(verify_dropped(Ids { egid: 0, ..exact }, &account, false).is_err());
    }

    #[test]
    fn the_observation_lists_this_personal_account_and_never_system_ones() {
        let accounts = observe();
        let me = me();
        let mine = json!({"gid": me["accountConfirmation"]["gid"], "home": me["accountConfirmation"]["home"],
            "homeDevice": me["accountConfirmation"]["homeDevice"], "homeInode": me["accountConfirmation"]["homeInode"],
            "name": me["accountConfirmation"]["name"], "uid": me["accountConfirmation"]["uid"]});
        assert!(accounts.contains(&mine), "{accounts:?}");
        assert!(accounts
            .iter()
            .all(|a| a["uid"].as_u64().unwrap() >= 501 && a["gid"] != 0));
        assert!(describe("root", 0, 0, "/var/root").is_none());
        assert!(describe("nobody", 4294967294, 4294967294, "/var/empty").is_none());
        assert!(
            describe("someone", 502, 20, "/Users/other").is_none(),
            "home must be /Users/<name>"
        );
    }

    #[test]
    fn a_confirmation_counts_only_for_a_reported_matching_account_and_is_answered() {
        use crate::wire::{read_frame, write_frame};
        use std::{
            os::unix::net::UnixStream,
            time::{Duration, Instant},
        };
        let key = [0x21; 32];
        let body = me();
        let reported = observe();
        let other = {
            let mut b = body.clone();
            b["accountConfirmation"]["homeInode"] = json!(1);
            b
        };
        for (confirmation, reported, accepted) in [
            (&body, reported.clone(), true),
            (&other, reported.clone(), false),
            (&body, vec![], false),
        ] {
            let (mut helper, mut owner) = UnixStream::pair().unwrap();
            let mut session = Session::fixture(key);
            write_frame(
                &mut owner,
                &Session::owner_frame(&key, 0, confirmation),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
            let result = session.await_confirmation(&mut helper, &reported, Duration::from_secs(1));
            assert_eq!(result.is_ok(), accepted, "{result:?}");
            let answer = Session::helper_body(
                &key,
                0,
                &read_frame(&mut owner, Instant::now() + Duration::from_secs(1)).unwrap(),
            )
            .unwrap();
            let digest = json!("c".repeat(64));
            if accepted {
                assert_eq!(
                    answer,
                    json!({"accountConfirmed": {"confirmationSha256": digest}})
                );
            } else {
                assert_eq!(answer["accountRefused"]["confirmationSha256"], digest);
            }
        }
    }

    #[test]
    fn no_confirmation_within_the_wait_selects_nothing() {
        use std::{
            os::unix::net::UnixStream,
            time::{Duration, Instant},
        };
        let (mut helper, _owner) = UnixStream::pair().unwrap();
        let mut session = Session::fixture([0x22; 32]);
        let started = Instant::now();
        assert!(session
            .await_confirmation(&mut helper, &observe(), Duration::from_millis(200))
            .is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
