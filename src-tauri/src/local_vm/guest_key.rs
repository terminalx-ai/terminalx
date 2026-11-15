//! The secret that lets only this host drive a guest's runtime.
//!
//! A guest's workers run as the guest runtime's own OS account, so anything
//! the runtime can read from disk they can read too, including its control
//! token. The guest therefore keeps only this key's SHA-256 (`hostKeySha256`
//! in identity.json, written at installation), and every `local_vm.guest`
//! request must carry the key itself, which only the host holds: under
//! `$TERMINALX_HOME/local-vm/guest-keys`, never in the journal or its state
//! reports. It travels on the transport's stdin, never in argv or a log.
use anyhow::{bail, Context, Result};
use rand_core::{OsRng, RngCore};
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use super::journal;

fn path(root: &Path, environment_id: &str) -> Result<PathBuf> {
    journal::validate_id(environment_id)?;
    Ok(root.join("guest-keys").join(format!("{environment_id}.key")))
}

/// The key for `environment_id`, made the first time a runtime is installed.
pub(super) fn ensure(root: &Path, environment_id: &str) -> Result<Zeroizing<String>> {
    let file = path(root, environment_id)?;
    if file.try_exists()? {
        return read(root, environment_id);
    }
    journal::private_directory(file.parent().context("Guest key directory missing")?)?;
    let mut bytes = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(bytes.as_mut());
    let key = Zeroizing::new(bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
    journal::atomic_private_write(&file, key.as_bytes())?;
    Ok(key)
}

/// The key a request to this environment's runtime carries.
pub(super) fn read(root: &Path, environment_id: &str) -> Result<Zeroizing<String>> {
    let file = path(root, environment_id)?;
    let bytes = Zeroizing::new(super::admission::read_marker(&file).map_err(|_| {
        anyhow::anyhow!("This guest runtime was installed without a host key; install it again from Settings → Local VMs. No guest request was sent")
    })?);
    let key = Zeroizing::new(String::from_utf8(bytes.to_vec()).context("Unreadable guest key")?);
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("Damaged guest key; install the guest runtime again. No guest request was sent");
    }
    Ok(key)
}

/// What the guest keeps in place of the key.
pub(crate) fn verifier(key: &str) -> String {
    journal::digest(key.as_bytes())
}

/// Whether `offered` is the key whose digest the guest keeps, compared in
/// constant time.
pub(crate) fn matches(verifier_sha256: &str, offered: &str) -> bool {
    verifier(offered).as_bytes().ct_eq(verifier_sha256.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_made_once_kept_private_and_only_its_digest_verifies() {
        let root = tempfile::tempdir().unwrap();
        let (env, other) = (journal::new_id(), journal::new_id());
        let first = ensure(root.path(), &env).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(*ensure(root.path(), &env).unwrap(), *first, "an existing key is kept");
        assert_eq!(*read(root.path(), &env).unwrap(), *first);
        assert_ne!(*ensure(root.path(), &other).unwrap(), *first);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path(root.path(), &env).unwrap()).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
        let digest = verifier(&first);
        assert!(matches(&digest, &first));
        assert!(!matches(&digest, &digest), "the digest is not the key");
        assert!(!matches(&digest, ""));
        assert!(read(root.path(), &journal::new_id()).is_err());
        assert!(ensure(root.path(), "../escape").is_err());
    }
}
