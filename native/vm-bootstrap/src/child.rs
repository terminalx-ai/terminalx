//! The helper's account-child run loop (design slice 3). After the person's
//! confirmation it waits for the host's key grant over the session, installs it
//! in a forked child that has first dropped permanently to the confirmed
//! account, and reports a result bound to the grant's key reference. The root
//! parent never opens an account file; a failed or unreadable child result is
//! reported as refused or unknown, never as installed.
use crate::{
    account::{drop_to, ConfirmedAccount},
    enroll::Session,
    fsx::Dir,
    keys::{self, KeyGrant},
    wire::Stream,
};
use serde_json::json;
use std::{
    io::{self, Read, Write},
    os::fd::FromRawFd,
    path::PathBuf,
    time::Duration,
};

/// Installs a grant as the confirmed account and returns the install stage:
/// `publicKeyInstalled`, `outcomeUnknown` or `refused`.
pub trait Installer {
    fn install(&mut self, account: &ConfirmedAccount, grant: &KeyGrant) -> String;
}

/// The production installer. `state` is the helper's root-owned state
/// directory; each account gets a private journal there before the fork.
pub struct Forking {
    pub state: PathBuf,
}

fn stage_of(result: io::Result<serde_json::Value>) -> String {
    match result {
        Ok(receipt) if receipt["stage"] == "publicKeyInstalled" => "publicKeyInstalled".into(),
        Ok(_) => "outcomeUnknown".into(),
        Err(_) => "refused".into(),
    }
}

impl Forking {
    /// Root only: the account's private journal, created and given to the
    /// account before the drop so the child can write intent before effect.
    fn journal(&self, account: &ConfirmedAccount) -> io::Result<PathBuf> {
        let state = Dir::open_root(&self.state)?;
        if state.stat.st_uid != 0 || state.stat.st_mode & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "helper state must be root-only",
            ));
        }
        let name = format!("account-{}", account.uid);
        if state.stat_at(&name)?.is_none() {
            state.make_dir(&name, 0o700)?;
        }
        let journal = state.open_dir(&name)?;
        // SAFETY: journal owns its descriptor; changes only this directory's owner.
        if unsafe { libc::fchown(journal.fd(), account.uid, account.gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(self.state.join(name))
    }
}

impl Installer for Forking {
    fn install(&mut self, account: &ConfirmedAccount, grant: &KeyGrant) -> String {
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } != 0 {
            return "refused".into(); // nothing is prepared, forked or written
        }
        let Ok(journal) = self.journal(account) else {
            return "refused".into();
        };
        let mut pipe = [0; 2];
        // SAFETY: pipe fills two new descriptors.
        if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
            return "refused".into();
        }
        // SAFETY: the helper is single-threaded here; the child only drops,
        // installs, writes one short word and exits without returning.
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            // SAFETY: the child's write end, owned here alone.
            let mut out = unsafe { std::fs::File::from_raw_fd(pipe[1]) };
            let stage = stage_of(drop_to(account).and_then(|dropped| {
                let home = keys::open_home(&dropped)?;
                let journal = Dir::open_root(&journal)?;
                keys::install(&dropped, grant, &home, &journal, |_| Ok(()))
            }));
            let _ = out.write_all(stage.as_bytes());
            // SAFETY: leave the forked child without running parent destructors.
            unsafe { libc::_exit(0) };
        }
        // SAFETY: the parent closes the write end it does not use.
        unsafe { libc::close(pipe[1]) };
        if pid < 0 {
            // SAFETY: closing the unused read end.
            unsafe { libc::close(pipe[0]) };
            return "refused".into();
        }
        // SAFETY: the parent's read end, owned here alone.
        let mut input = unsafe { std::fs::File::from_raw_fd(pipe[0]) };
        let mut word = String::new();
        let _ = Read::by_ref(&mut input).take(32).read_to_string(&mut word);
        let mut status = 0;
        // SAFETY: waiting for this exact child.
        unsafe { libc::waitpid(pid, &mut status, 0) };
        if ["publicKeyInstalled", "outcomeUnknown", "refused"].contains(&word.as_str())
            && libc::WIFEXITED(status)
        {
            word
        } else {
            "outcomeUnknown".into()
        }
    }
}

/// After the confirmation: waits up to `wait` for the key grant, installs it
/// through `installer`, and reports `{keyResult: {keyReference, stage}}`.
/// Returns the stage and the grant's key reference.
pub fn grant_and_report(
    session: &mut Session,
    stream: &mut impl Stream,
    account: &ConfirmedAccount,
    bootstrap_id: &str,
    wait: Duration,
    installer: &mut impl Installer,
) -> io::Result<(String, String)> {
    session.set_wait(wait);
    let grant = session.receive_key_grant(stream, bootstrap_id)?;
    let stage = installer.install(account, &grant);
    session.send(
        stream,
        json!({"keyResult": {"keyReference": grant.key_reference, "stage": stage}}),
    )?;
    Ok((stage, grant.key_reference))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        account::Dropped,
        wire::{read_frame, write_frame},
    };
    use std::{
        os::unix::{
            fs::{MetadataExt, PermissionsExt},
            net::UnixStream,
        },
        time::Instant,
    };

    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
    const REFERENCE: &str = "6f1d7c2e-0b9a-4c55-9d1e-2a3b4c5d6e7f";

    /// Installs into disposable directories as this user, with a fixture drop.
    struct Disposable {
        home: PathBuf,
        journal: PathBuf,
    }
    impl Installer for Disposable {
        fn install(&mut self, account: &ConfirmedAccount, grant: &KeyGrant) -> String {
            let dropped = Dropped::fixture(account.clone());
            stage_of(Dir::open_root(&self.home).and_then(|home| {
                keys::install(
                    &dropped,
                    grant,
                    &home,
                    &Dir::open_root(&self.journal)?,
                    |_| Ok(()),
                )
            }))
        }
    }

    fn account(home: &std::path::Path) -> ConfirmedAccount {
        let meta = std::fs::metadata(home).unwrap();
        // SAFETY: no preconditions.
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        ConfirmedAccount::fixture(
            "fixture",
            uid,
            gid,
            home.to_str().unwrap(),
            meta.dev(),
            meta.ino(),
        )
    }

    fn exchange(
        installer: &mut impl Installer,
        account: &ConfirmedAccount,
    ) -> (String, serde_json::Value) {
        let key = [0x41; 32];
        let (mut helper, mut owner) = UnixStream::pair().unwrap();
        let grant = json!({"keyGrant": {"keyReference": REFERENCE, "publicKey": KEY}});
        write_frame(
            &mut owner,
            &Session::owner_frame(&key, 0, &grant),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let mut session = Session::fixture(key);
        let (stage, reference) = grant_and_report(
            &mut session,
            &mut helper,
            account,
            "boot-1",
            Duration::from_secs(1),
            installer,
        )
        .unwrap();
        assert_eq!(reference, REFERENCE);
        let reported = Session::helper_body(
            &key,
            0,
            &read_frame(&mut owner, Instant::now() + Duration::from_secs(1)).unwrap(),
        )
        .unwrap();
        (stage, reported)
    }

    #[test]
    fn a_granted_key_is_installed_and_the_bound_result_reported() {
        let temp = tempfile::tempdir().unwrap();
        let (home, journal) = (temp.path().join("home"), temp.path().join("journal"));
        for dir in [&home, &journal] {
            std::fs::create_dir(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let account = account(&home);
        let (stage, reported) = exchange(
            &mut Disposable {
                home: home.clone(),
                journal,
            },
            &account,
        );
        assert_eq!(stage, "publicKeyInstalled");
        assert_eq!(
            reported,
            json!({"keyResult": {"keyReference": REFERENCE, "stage": "publicKeyInstalled"}})
        );
        assert!(std::fs::read_to_string(home.join(".ssh/authorized_keys"))
            .unwrap()
            .contains("terminalx-bootstrap:boot-1"));
    }

    #[test]
    fn without_root_the_forking_installer_refuses_before_anything_is_written() {
        // SAFETY: no preconditions.
        if unsafe { libc::geteuid() } == 0 {
            return; // the unprivileged refusal path only
        }
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let account = account(&home);
        let (stage, reported) = exchange(
            &mut Forking {
                state: temp.path().join("state"),
            },
            &account,
        );
        assert_eq!(stage, "refused");
        assert_eq!(reported["keyResult"]["stage"], "refused");
        assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);
        assert!(!temp.path().join("state").exists());
    }

    #[test]
    fn an_untagged_or_late_grant_installs_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let account = account(&home);
        struct Never;
        impl Installer for Never {
            fn install(&mut self, _: &ConfirmedAccount, _: &KeyGrant) -> String {
                panic!("no install without a tagged grant")
            }
        }
        let (mut helper, mut owner) = UnixStream::pair().unwrap();
        let grant = json!({"keyGrant": {"keyReference": REFERENCE, "publicKey": KEY}});
        write_frame(
            &mut owner,
            &Session::owner_frame(&[0x99; 32], 0, &grant),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert!(grant_and_report(
            &mut Session::fixture([0x41; 32]),
            &mut helper,
            &account,
            "boot-1",
            Duration::from_secs(1),
            &mut Never
        )
        .is_err());
        let (mut helper, _silent) = UnixStream::pair().unwrap();
        assert!(grant_and_report(
            &mut Session::fixture([0x41; 32]),
            &mut helper,
            &account,
            "boot-1",
            Duration::from_millis(200),
            &mut Never
        )
        .is_err());
    }
}
