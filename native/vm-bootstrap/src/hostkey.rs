//! The trust step's guest evidence (design "Final trust confirmation"). After
//! the helper's own `publicKeyInstalled`, it reads the guest's existing SSH
//! Ed25519 public host key and reports it over the session with the installed
//! grant's key reference. It never reads a private host key, generates host
//! keys, or changes sshd or Remote Login: while the key is absent it waits, and
//! it reports nothing if none appears. The report is evidence for the person's
//! review on the host; it is not trust by itself.
use crate::{
    enroll::Session,
    fsx::{fstat, Dir},
    wire::Stream,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{
    io::{self, Read},
    os::fd::AsRawFd,
    path::Path,
    time::{Duration, Instant},
};

/// The public half only; the private host key is never opened.
pub const HOST_KEY: &str = "ssh_host_ed25519_key.pub";

fn refused(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason)
}

/// `ssh-ed25519 <blob>` from one public key line; an optional comment is dropped.
fn parse(bytes: &[u8]) -> io::Result<String> {
    let text = std::str::from_utf8(bytes).map_err(|_| refused("the host key is not text"))?;
    let line = text.strip_suffix('\n').unwrap_or(text);
    let mut parts = line.split(' ');
    let (kind, blob, comment) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next(),
    );
    let decoded = STANDARD.decode(blob).unwrap_or_default();
    if kind != "ssh-ed25519"
        || parts.next().is_some()
        || comment.is_some_and(|c| c.is_empty() || !c.bytes().all(|b| b.is_ascii_graphic()))
        || decoded.len() != 51
        || decoded[..4] != 11_u32.to_be_bytes()
        || &decoded[4..15] != b"ssh-ed25519"
        || decoded[15..19] != 32_u32.to_be_bytes()
    {
        return Err(refused("not one ed25519 public host key"));
    }
    Ok(format!("{kind} {blob}"))
}

/// The existing public host key in `ssh_dir` (`/etc/ssh` in production), which
/// with the file must belong to `owner` (root in production) and be writable
/// by no one else. `None` while the file does not exist.
pub fn read_host_key(ssh_dir: &Path, owner: u32) -> io::Result<Option<String>> {
    let dir = Dir::open_root(ssh_dir)?;
    if dir.stat.st_uid != owner || dir.stat.st_mode & 0o022 != 0 {
        return Err(refused("the SSH directory is writable by another account"));
    }
    if dir.stat_at(HOST_KEY)?.is_none() {
        return Ok(None);
    }
    let (file, before) = dir.open_regular(HOST_KEY)?;
    if before.st_uid != owner || before.st_mode & 0o022 != 0 || before.st_nlink != 1 {
        return Err(refused(
            "the public host key is writable by another account",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut &file)
        .take(4097)
        .read_to_end(&mut bytes)?;
    let after = fstat(file.as_raw_fd())?;
    if bytes.len() > 4096
        || after.st_size != before.st_size
        || after.st_mtime != before.st_mtime
        || after.st_mtime_nsec != before.st_mtime_nsec
        || after.st_ino != before.st_ino
    {
        return Err(refused("the public host key changed while it was read"));
    }
    parse(&bytes).map(Some)
}

/// After the helper's own `publicKeyInstalled` for `key_reference`: waits up
/// to `wait` for the existing host key, then sends `{hostKey: {keyReference,
/// publicKey}}` once. While it is absent, `{hostKeyPending: {keyReference}}`
/// is sent about once a second so the owner can tell waiting from silence.
/// Returns the reported key, or `None` when none appeared in time.
pub fn report_host_key(
    session: &mut Session,
    stream: &mut impl Stream,
    key_reference: &str,
    ssh_dir: &Path,
    owner: u32,
    wait: Duration,
) -> io::Result<Option<String>> {
    let deadline = Instant::now() + wait;
    loop {
        if let Some(key) = read_host_key(ssh_dir, owner)? {
            session.send(
                stream,
                json!({"hostKey": {"keyReference": key_reference, "publicKey": key}}),
            )?;
            return Ok(Some(key));
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(None);
        }
        session.send(
            stream,
            json!({"hostKeyPending": {"keyReference": key_reference}}),
        )?;
        std::thread::sleep((deadline - now).min(Duration::from_secs(1)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::read_frame;
    use std::os::unix::{fs::PermissionsExt, net::UnixStream};

    const REFERENCE: &str = "6f1d7c2e-0b9a-4c55-9d1e-2a3b4c5d6e7f";

    fn key(fill: u8) -> String {
        let mut bytes = 11_u32.to_be_bytes().to_vec();
        bytes.extend(b"ssh-ed25519");
        bytes.extend(32_u32.to_be_bytes());
        bytes.extend([fill; 32]);
        format!("ssh-ed25519 {}", STANDARD.encode(bytes))
    }
    fn euid() -> u32 {
        // SAFETY: no preconditions.
        unsafe { libc::geteuid() }
    }
    fn ssh_dir() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        temp
    }
    fn write(dir: &Path, text: &str, mode: u32) {
        std::fs::write(dir.join(HOST_KEY), text).unwrap();
        std::fs::set_permissions(dir.join(HOST_KEY), std::fs::Permissions::from_mode(mode))
            .unwrap();
    }

    #[test]
    fn only_one_ed25519_public_host_key_line_is_accepted() {
        assert_eq!(
            parse(format!("{} root@guest\n", key(3)).as_bytes()).unwrap(),
            key(3)
        );
        assert_eq!(parse(key(3).as_bytes()).unwrap(), key(3));
        let blob = key(3).split_once(' ').unwrap().1.to_string();
        for bad in [
            String::new(),
            format!("ssh-rsa {blob}"),
            format!("{}\n{}\n", key(3), key(4)),
            format!("{} root@guest extra", key(3)),
            format!("{} ", key(3)),
            "ssh-ed25519 AAAA".into(),
            format!("ssh-ed25519 {}", &blob[..blob.len() - 4]),
            "-----BEGIN OPENSSH PRIVATE KEY-----".into(),
        ] {
            assert!(parse(bad.as_bytes()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_existing_owner_only_public_host_key_is_read_and_absence_is_a_wait() {
        let temp = ssh_dir();
        assert_eq!(read_host_key(temp.path(), euid()).unwrap(), None);
        write(temp.path(), &format!("{} root@guest\n", key(5)), 0o644);
        assert_eq!(read_host_key(temp.path(), euid()).unwrap(), Some(key(5)));
        assert!(
            read_host_key(temp.path(), euid() + 1).is_err(),
            "another owner"
        );
        std::fs::set_permissions(
            temp.path().join(HOST_KEY),
            std::fs::Permissions::from_mode(0o664),
        )
        .unwrap();
        assert!(
            read_host_key(temp.path(), euid()).is_err(),
            "group-writable file"
        );
        std::fs::set_permissions(
            temp.path().join(HOST_KEY),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o775)).unwrap();
        assert!(
            read_host_key(temp.path(), euid()).is_err(),
            "group-writable directory"
        );
    }

    #[test]
    fn a_linked_or_aliased_host_key_is_refused() {
        let temp = ssh_dir();
        let elsewhere = temp.path().join("elsewhere.pub");
        std::fs::write(&elsewhere, key(6)).unwrap();
        std::os::unix::fs::symlink(&elsewhere, temp.path().join(HOST_KEY)).unwrap();
        assert!(read_host_key(temp.path(), euid()).is_err(), "symlink");
        std::fs::remove_file(temp.path().join(HOST_KEY)).unwrap();
        std::fs::hard_link(&elsewhere, temp.path().join(HOST_KEY)).unwrap();
        assert!(read_host_key(temp.path(), euid()).is_err(), "hard link");
    }

    #[test]
    fn the_key_is_reported_once_it_exists_and_only_pending_is_sent_while_absent() {
        let temp = ssh_dir();
        let session_key = [0x41; 32];
        let (mut helper, mut owner) = UnixStream::pair().unwrap();
        let mut session = Session::fixture(session_key);
        let none = report_host_key(
            &mut session,
            &mut helper,
            REFERENCE,
            temp.path(),
            euid(),
            Duration::from_millis(200),
        )
        .unwrap();
        assert_eq!(none, None);
        let pending = json!({"hostKeyPending": {"keyReference": REFERENCE}});
        let frame = |seq: u64, owner: &mut UnixStream| {
            Session::helper_body(
                &session_key,
                seq,
                &read_frame(owner, Instant::now() + Duration::from_secs(1)).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(frame(0, &mut owner), pending, "waiting, never a key");
        let path = temp.path().to_path_buf();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            write(&path, &key(8), 0o644);
        });
        let reported = report_host_key(
            &mut session,
            &mut helper,
            REFERENCE,
            temp.path(),
            euid(),
            Duration::from_secs(5),
        )
        .unwrap();
        writer.join().unwrap();
        assert_eq!(reported, Some(key(8)));
        assert_eq!(frame(1, &mut owner), pending);
        assert_eq!(
            frame(2, &mut owner),
            json!({"hostKey": {"keyReference": REFERENCE, "publicKey": key(8)}})
        );
    }
}
