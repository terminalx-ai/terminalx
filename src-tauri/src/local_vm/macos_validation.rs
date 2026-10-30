//! Validation builds only (cargo feature `vm-validation`; never a release).
//! The validation plan's Run 2 inputs, the restricted Lume pin and the Apple
//! restore entry, come from owner-only files a person placed in a dedicated,
//! non-default TERMINALX_HOME. Release builds compile none of this, so their
//! restricted-artifact catalog and restore catalog stay empty.
use anyhow::{bail, Context, Result};
use std::path::Path;

/// `root` is the local-vm directory of a dedicated TERMINALX_HOME, never the
/// default `~/.raccoon` or `/`.
fn dedicated(root: &Path, configured: Option<&str>, default_home: &Path) -> Result<()> {
    let home = Path::new(configured.context("Validation builds require a dedicated TERMINALX_HOME")?)
        .canonicalize()
        .context("Validation home is unavailable")?;
    let default = default_home.canonicalize().unwrap_or_else(|_| default_home.to_path_buf());
    if home == default || home == Path::new("/") {
        bail!("Validation builds never use the default TerminalX home")
    }
    if root.canonicalize().context("Validation root is unavailable")? != home.join("local-vm") {
        bail!("Validation inputs belong only to the dedicated home's local-vm root")
    }
    Ok(())
}

fn input_using(root: &Path, name: &str, limit: u64, configured: Option<&str>, default_home: &Path) -> Result<Vec<u8>> {
    if !matches!(name, "restricted-lume.json" | "restore-catalog.json") {
        bail!("Unknown validation input")
    }
    dedicated(root, configured, default_home)?;
    super::macos_keys::private_read(&root.join("validation").join(name), limit)
}

/// An owner-only validation input from the dedicated home's `validation/`.
pub(super) fn input(root: &Path, name: &str, limit: u64) -> Result<Vec<u8>> {
    let default_home = dirs::home_dir().context("no home directory")?.join(".raccoon");
    input_using(root, name, limit, crate::store::state_home_env().as_deref(), &default_home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn home() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("local-vm");
        std::fs::create_dir_all(root.join("validation")).unwrap();
        (dir, root)
    }

    #[test]
    fn only_a_dedicated_non_default_home_supplies_validation_inputs() {
        let (dir, root) = home();
        let path = root.join("validation/restore-catalog.json");
        std::fs::write(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let configured = dir.path().to_str().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        assert_eq!(input_using(&root, "restore-catalog.json", 4096, Some(configured), elsewhere.path()).unwrap(), b"{}");
        assert!(input_using(&root, "restore-catalog.json", 4096, None, elsewhere.path()).is_err(), "no TERMINALX_HOME");
        assert!(input_using(&root, "restore-catalog.json", 4096, Some(configured), dir.path()).is_err(), "the default home");
        assert!(input_using(&root, "restore-catalog.json", 4096, Some("/"), elsewhere.path()).is_err());
        assert!(input_using(&root.join("validation"), "restore-catalog.json", 4096, Some(configured), elsewhere.path()).is_err(), "another root");
        assert!(input_using(&root, "../restore-catalog.json", 4096, Some(configured), elsewhere.path()).is_err(), "unknown name");
        let gone = elsewhere.path().join("deleted-home");
        let error = input_using(&root, "restore-catalog.json", 4096, gone.to_str(), dir.path()).unwrap_err();
        assert!(error.to_string().starts_with("Validation"), "every profile refusal names itself: {error}");
    }

    #[test]
    fn validation_inputs_must_be_owner_only_and_bounded() {
        let (dir, root) = home();
        let path = root.join("validation/restricted-lume.json");
        std::fs::write(&path, vec![b'x'; 8192]).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let configured = dir.path().to_str().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(input_using(&root, "restricted-lume.json", 4096, Some(configured), elsewhere.path()).is_err(), "group/world readable");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(input_using(&root, "restricted-lume.json", 4096, Some(configured), elsewhere.path()).is_err(), "over the bound");
    }
}
