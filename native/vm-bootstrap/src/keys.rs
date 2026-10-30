//! Design slice 3, the account child's only effect: the host's public key for
//! this bootstrap appended to the confirmed account's authorized_keys, with the
//! desktop engine's shared transformation (`authorized_keys_text`). It takes a
//! `Dropped` proof, so no account file is opened before the person's
//! confirmation arrives over the session and the process has permanently become
//! that account. Intent is journaled before any effect, as in the desktop
//! engine; nothing is replayed, replaced or regenerated, and an inconsistent
//! file is reported as an unknown outcome instead of being repaired.
use crate::{
    account::Dropped,
    authorized_keys_text::{append, KEYS_LIMIT},
    enroll::Session,
    fsx::{self, Dir},
    sha256,
    wire::Stream,
};
use serde_json::{json, Value};
use std::{
    io::{self, Read, Seek, SeekFrom, Write},
    os::fd::AsRawFd,
    path::Path,
};

fn refused(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason.into())
}

/// The host's public key for this bootstrap, as granted over the session.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct KeyGrant {
    pub public_key: String,
    pub key_reference: String,
    pub bootstrap_id: String,
}

impl KeyGrant {
    fn from_body(body: &Value, bootstrap_id: &str) -> io::Result<KeyGrant> {
        let grant = body
            .as_object()
            .filter(|o| o.len() == 1)
            .and_then(|o| o.get("keyGrant"))
            .and_then(Value::as_object);
        let grant = grant
            .filter(|g| g.len() == 2)
            .ok_or_else(|| refused("not a key grant"))?;
        let public_key = grant
            .get("publicKey")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let reference = grant
            .get("keyReference")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (kind, blob) = public_key.split_once(' ').unwrap_or_default();
        if kind != "ssh-ed25519"
            || blob.is_empty()
            || blob.len() > 128
            || !blob
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
            || reference.len() != 36
            || !reference
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-')
        {
            return Err(refused(
                "the key grant is not one ed25519 public key with its reference",
            ));
        }
        Ok(KeyGrant {
            public_key: public_key.into(),
            key_reference: reference.into(),
            bootstrap_id: bootstrap_id.into(),
        })
    }

    fn to_json(&self) -> Value {
        json!({"publicKey": self.public_key, "keyReference": self.key_reference, "bootstrapId": self.bootstrap_id})
    }

    #[cfg(test)]
    pub(crate) fn fixture(public_key: &str, bootstrap_id: &str) -> KeyGrant {
        KeyGrant {
            public_key: public_key.into(),
            key_reference: "6f1d7c2e-0b9a-4c55-9d1e-2a3b4c5d6e7f".into(),
            bootstrap_id: bootstrap_id.into(),
        }
    }
}

impl Session {
    /// The only way to obtain a `KeyGrant`: the next owner frame, tagged under
    /// this verified session.
    pub fn receive_key_grant(
        &mut self,
        stream: &mut impl Stream,
        bootstrap_id: &str,
    ) -> io::Result<KeyGrant> {
        KeyGrant::from_body(&self.receive(stream)?, bootstrap_id)
    }
}

/// Opens the confirmed account's home by path and requires it to be the very
/// directory the person confirmed: same device, inode and owner.
pub fn open_home(dropped: &Dropped) -> io::Result<Dir> {
    let account = dropped.account();
    let home = Dir::open_root(Path::new(&account.home))?;
    check_home(dropped, &home)?;
    Ok(home)
}

fn check_home(dropped: &Dropped, home: &Dir) -> io::Result<()> {
    let account = dropped.account();
    if home.stat.st_dev as u64 != account.home_device
        || home.stat.st_ino != account.home_inode
        || home.stat.st_uid != account.uid
        || home.stat.st_mode & 0o022 != 0
    {
        return Err(refused(
            "the home directory is not the one the person confirmed",
        ));
    }
    Ok(())
}

fn read_json(dir: &Dir, name: &str) -> io::Result<Option<Value>> {
    if dir.stat_at(name)?.is_none() {
        return Ok(None);
    }
    let (mut file, _) = dir.open_regular(name)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(512 * 1024)
        .read_to_end(&mut bytes)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

fn node(stat: &libc::stat) -> Value {
    json!({"device": stat.st_dev, "inode": stat.st_ino})
}

fn read_keys(file: &mut std::fs::File) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    Read::by_ref(file)
        .take(KEYS_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > KEYS_LIMIT {
        return Err(refused("authorized_keys is larger than the bound"));
    }
    Ok(bytes)
}

/// Where an interrupted install stopped, for fixtures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Intent,
    WriteIntent,
    Appended,
}

/// Installs the grant into `home/.ssh/authorized_keys`, journaling in `journal`
/// (the account-owned directory the root helper prepared before the drop).
pub fn install(
    dropped: &Dropped,
    grant: &KeyGrant,
    home: &Dir,
    journal: &Dir,
    mut step: impl FnMut(Step) -> io::Result<()>,
) -> io::Result<Value> {
    let account = dropped.account();
    check_home(dropped, home)?;
    if journal.stat.st_uid != account.uid || journal.stat.st_mode & 0o077 != 0 {
        return Err(refused(
            "the install journal must be private to the account",
        ));
    }
    if let Some(receipt) = read_json(journal, "key-receipt.json")? {
        if receipt["grant"] != grant.to_json() {
            return Err(refused(
                "a different key was already installed; no replacement",
            ));
        }
        return Ok(receipt);
    }
    let existed = match read_json(journal, "key-intent.json")? {
        Some(intent) if intent == grant.to_json() => true,
        Some(_) => return Err(refused("the original key intent changed; no replacement")),
        None => {
            if journal.stat_at("write-intent.json")?.is_some() {
                return Err(refused("the original key intent is missing"));
            }
            journal.publish_new("key-intent.json", &serde_json::to_vec(&grant.to_json())?)?;
            step(Step::Intent)?;
            false
        }
    };
    let write_intent = read_json(journal, "write-intent.json")?;
    if existed && write_intent.is_none() {
        return Err(refused("the original preparation outcome is unknown; no directory or file creation is replayed"));
    }
    if home.stat_at(".ssh")?.is_none() {
        if existed {
            return Err(refused("the original .ssh directory is missing"));
        }
        home.make_dir(".ssh", 0o700)?;
    }
    let ssh = home.open_dir(".ssh")?;
    if ssh.stat.st_uid != account.uid
        || ssh.stat.st_mode & 0o077 != 0
        || ssh.stat.st_dev != home.stat.st_dev
    {
        return Err(refused(
            ".ssh must be private to the account on the home's device",
        ));
    }
    let mut file = match ssh.stat_at("authorized_keys")? {
        None if !existed => ssh
            .create_new("authorized_keys", 0o600)
            .and_then(|_| ssh.open_regular_rw("authorized_keys"))?,
        None => return Err(refused("the original authorized_keys is missing")),
        Some(_) => ssh.open_regular_rw("authorized_keys")?,
    };
    // SAFETY: file owns its descriptor for the lock's lifetime.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(refused("authorized_keys is locked by another writer"));
    }
    let stat = fsx::fstat(file.as_raw_fd())?;
    if stat.st_uid != account.uid || stat.st_nlink != 1 || stat.st_mode & 0o077 != 0 {
        return Err(refused(
            "authorized_keys must be one private file of the account",
        ));
    }
    let (before, after) = match write_intent {
        Some(intent) => {
            if intent["grant"] != grant.to_json()
                || intent["ssh"] != node(&ssh.stat)
                || intent["file"] != node(&stat)
            {
                return Err(refused("the original key file or directory changed"));
            }
            let before = intent["before"]
                .as_str()
                .map(|b| b.as_bytes().to_vec())
                .unwrap_or_default();
            let after = append(&before, &grant.public_key, &grant.bootstrap_id).map_err(refused)?;
            if sha256(&after) != intent["afterSha256"] {
                return Err(refused("the original write intent is inconsistent"));
            }
            (before, after)
        }
        None => {
            let before = read_keys(&mut file)?;
            let after = append(&before, &grant.public_key, &grant.bootstrap_id).map_err(refused)?;
            let text = String::from_utf8(before.clone())
                .map_err(|_| refused("authorized_keys is not text"))?;
            journal.publish_new(
                "write-intent.json",
                &serde_json::to_vec(&json!({"grant": grant.to_json(), "ssh": node(&ssh.stat),
                "file": node(&stat), "before": text, "afterSha256": sha256(&after)}))?,
            )?;
            step(Step::WriteIntent)?;
            if read_keys(&mut file)? != before {
                return Err(refused("authorized_keys changed before the write"));
            }
            file.seek(SeekFrom::End(0))?;
            file.write_all(&after[before.len()..])?;
            file.sync_all()?;
            step(Step::Appended)?;
            (before, after)
        }
    };
    if read_keys(&mut file)? != after {
        return Ok(
            json!({"stage": "outcomeUnknown", "detail": "The original key write is incomplete or changed; no append, replacement or regeneration was attempted",
            "ready": false, "trustAccepted": false}),
        );
    }
    file.sync_all()?;
    let receipt = json!({"version": 1, "stage": "publicKeyInstalled", "account": {"name": account.name, "uid": account.uid},
        "confirmationSha256": account.confirmation_sha256, "grant": grant.to_json(), "file": node(&stat),
        "beforeSha256": sha256(&before), "afterSha256": sha256(&after), "ready": false, "trustAccepted": false});
    journal.publish_new("key-receipt.json", &serde_json::to_vec(&receipt)?)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::ConfirmedAccount;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";

    struct Fixture {
        _temp: tempfile::TempDir,
        home_path: std::path::PathBuf,
        home: Dir,
        journal: Dir,
        dropped: Dropped,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let home_path = temp.path().join("home");
        let journal_path = temp.path().join("journal");
        for dir in [&home_path, &journal_path] {
            std::fs::create_dir(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let meta = std::fs::metadata(&home_path).unwrap();
        // SAFETY: no preconditions.
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        let account = ConfirmedAccount::fixture(
            "fixture",
            uid,
            gid,
            home_path.to_str().unwrap(),
            meta.dev(),
            meta.ino(),
        );
        Fixture {
            home: Dir::open_root(&home_path).unwrap(),
            journal: Dir::open_root(&journal_path).unwrap(),
            home_path,
            _temp: temp,
            dropped: Dropped::fixture(account),
        }
    }

    fn grant() -> KeyGrant {
        KeyGrant::fixture(KEY, "boot-1")
    }

    fn keys(f: &Fixture) -> Vec<u8> {
        std::fs::read(f.home_path.join(".ssh/authorized_keys")).unwrap()
    }

    #[test]
    fn installs_once_with_private_modes_and_a_rerun_changes_nothing() {
        let f = fixture();
        let receipt = install(&f.dropped, &grant(), &f.home, &f.journal, |_| Ok(())).unwrap();
        assert_eq!(receipt["stage"], "publicKeyInstalled");
        assert_eq!(
            (
                receipt["ready"].as_bool(),
                receipt["trustAccepted"].as_bool()
            ),
            (Some(false), Some(false))
        );
        assert_eq!(keys(&f), append(b"", KEY, "boot-1").unwrap());
        assert_eq!(
            std::fs::metadata(f.home_path.join(".ssh")).unwrap().mode() & 0o7777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(f.home_path.join(".ssh/authorized_keys"))
                .unwrap()
                .mode()
                & 0o7777,
            0o600
        );
        assert_eq!(
            install(&f.dropped, &grant(), &f.home, &f.journal, |_| panic!(
                "no second effect"
            ))
            .unwrap(),
            receipt
        );
        assert_eq!(keys(&f), append(b"", KEY, "boot-1").unwrap());
        let other = KeyGrant::fixture("ssh-ed25519 AAAAOTHER", "boot-1");
        assert!(
            install(&f.dropped, &other, &f.home, &f.journal, |_| Ok(())).is_err(),
            "never a replacement key"
        );
    }

    #[test]
    fn existing_lines_are_kept_and_markers_or_duplicates_refuse_without_writing() {
        let f = fixture();
        std::fs::create_dir(f.home_path.join(".ssh")).unwrap();
        std::fs::set_permissions(
            f.home_path.join(".ssh"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let path = f.home_path.join(".ssh/authorized_keys");
        std::fs::write(&path, b"ssh-rsa AAAA mine").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        install(&f.dropped, &grant(), &f.home, &f.journal, |_| Ok(())).unwrap();
        assert_eq!(
            keys(&f),
            append(b"ssh-rsa AAAA mine", KEY, "boot-1").unwrap()
        );

        let g = fixture();
        std::fs::create_dir(g.home_path.join(".ssh")).unwrap();
        std::fs::set_permissions(
            g.home_path.join(".ssh"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let path = g.home_path.join(".ssh/authorized_keys");
        std::fs::write(&path, b"x terminalx-bootstrap:old\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(install(&g.dropped, &grant(), &g.home, &g.journal, |_| Ok(())).is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"x terminalx-bootstrap:old\n"
        );
    }

    #[test]
    fn links_and_open_modes_are_refused_and_never_followed() {
        let outside = tempfile::tempdir().unwrap();
        let f = fixture();
        symlink(outside.path(), f.home_path.join(".ssh")).unwrap();
        assert!(install(&f.dropped, &grant(), &f.home, &f.journal, |_| Ok(())).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);

        let g = fixture();
        std::fs::create_dir(g.home_path.join(".ssh")).unwrap();
        std::fs::set_permissions(
            g.home_path.join(".ssh"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let target = outside.path().join("victim");
        std::fs::write(&target, b"untouched").unwrap();
        symlink(&target, g.home_path.join(".ssh/authorized_keys")).unwrap();
        assert!(install(&g.dropped, &grant(), &g.home, &g.journal, |_| Ok(())).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"untouched");

        let h = fixture();
        std::fs::create_dir(h.home_path.join(".ssh")).unwrap();
        std::fs::set_permissions(
            h.home_path.join(".ssh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(
            install(&h.dropped, &grant(), &h.home, &h.journal, |_| Ok(())).is_err(),
            "a group-readable .ssh"
        );
    }

    #[test]
    fn an_interrupted_install_never_replays_creation_or_appends_twice() {
        let f = fixture();
        assert!(install(&f.dropped, &grant(), &f.home, &f.journal, |s| {
            if s == Step::Intent {
                Err(refused("crash"))
            } else {
                Ok(())
            }
        })
        .is_err());
        let error = install(&f.dropped, &grant(), &f.home, &f.journal, |_| Ok(())).unwrap_err();
        assert!(error.to_string().contains("outcome is unknown"), "{error}");
        assert!(
            !f.home_path.join(".ssh").exists(),
            "no creation after an unknown outcome"
        );

        let g = fixture();
        assert!(install(&g.dropped, &grant(), &g.home, &g.journal, |s| {
            if s == Step::Appended {
                Err(refused("crash"))
            } else {
                Ok(())
            }
        })
        .is_err());
        let receipt = install(&g.dropped, &grant(), &g.home, &g.journal, |_| {
            panic!("reconcile only")
        })
        .unwrap();
        assert_eq!(receipt["stage"], "publicKeyInstalled");
        assert_eq!(
            keys(&g),
            append(b"", KEY, "boot-1").unwrap(),
            "exactly one line"
        );

        let h = fixture();
        assert!(install(&h.dropped, &grant(), &h.home, &h.journal, |s| {
            if s == Step::WriteIntent {
                Err(refused("crash"))
            } else {
                Ok(())
            }
        })
        .is_err());
        std::fs::write(
            h.home_path.join(".ssh/authorized_keys"),
            b"changed meanwhile\n",
        )
        .unwrap();
        let outcome = install(&h.dropped, &grant(), &h.home, &h.journal, |_| {
            panic!("no write")
        })
        .unwrap();
        assert_eq!(outcome["stage"], "outcomeUnknown");
        assert_eq!(
            keys(&h),
            b"changed meanwhile\n",
            "never repaired or appended"
        );
    }

    #[test]
    fn a_home_other_than_the_confirmed_one_is_refused_before_any_write() {
        let f = fixture();
        let other = tempfile::tempdir().unwrap();
        std::fs::set_permissions(other.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let elsewhere = Dir::open_root(other.path()).unwrap();
        assert!(install(&f.dropped, &grant(), &elsewhere, &f.journal, |_| Ok(())).is_err());
        assert_eq!(std::fs::read_dir(other.path()).unwrap().count(), 0);
        assert_eq!(
            std::fs::read_dir(f.home_path.parent().unwrap().join("journal"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn a_key_grant_counts_only_when_tagged_under_the_session() {
        use crate::wire::write_frame;
        use std::{
            os::unix::net::UnixStream,
            time::{Duration, Instant},
        };
        let key = [0x31; 32];
        let body = json!({"keyGrant": {"keyReference": "6f1d7c2e-0b9a-4c55-9d1e-2a3b4c5d6e7f", "publicKey": KEY}});
        for (signing, ok) in [(key, true), ([0x32; 32], false)] {
            let (mut helper, mut owner) = UnixStream::pair().unwrap();
            write_frame(
                &mut owner,
                &Session::owner_frame(&signing, 0, &body),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
            let mut session = Session::fixture(key);
            assert_eq!(session.receive_key_grant(&mut helper, "boot-1").is_ok(), ok);
        }
        for bad in [
            json!({"keyGrant": {"keyReference": "x", "publicKey": KEY}}),
            json!({"keyGrant": {"keyReference": "6f1d7c2e-0b9a-4c55-9d1e-2a3b4c5d6e7f", "publicKey": "ssh-rsa AAAA"}}),
        ] {
            let (mut helper, mut owner) = UnixStream::pair().unwrap();
            write_frame(
                &mut owner,
                &Session::owner_frame(&key, 0, &bad),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
            assert!(Session::fixture(key)
                .receive_key_grant(&mut helper, "boot-1")
                .is_err());
        }
    }
}
