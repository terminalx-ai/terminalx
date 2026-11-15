//! The runtime accepts operating computers itself (PRO-341, docs/MACHINES.md
//! decision 4): over the direct listener and through the relay, with the
//! machine's one host key and a registry of paired computers kept apart
//! from the phones' `devices.json`. What it says to the window is in
//! `crate::machine_wire`.

pub(crate) mod key;

use std::path::Path;

use anyhow::{bail, Context, Result};

/// The machine host's directory in the runtime's data directory.
pub(crate) const DIR: &str = "machine-host";

/// Make `path` a directory only this user can enter, or check that it is one.
pub(crate) fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = std::fs::symlink_metadata(path)?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
            bail!("{} is not a directory of this user", path.display());
        }
        if metadata.mode() & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}
