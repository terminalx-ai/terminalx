//! Guest-side personalized account binding. OS account metadata, rather than
//! HOME, selects the installation. No account/credential is created or changed.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use super::guest_account::{current_user, User};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub short_name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
    pub home_device: u64,
    pub home_inode: u64,
}

pub(super) fn validate_name(name: &str) -> Result<()> {
    if name.len() < 2
        || name.len() > 32
        || !name.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        || matches!(name, "root" | "lume" | "daemon" | "nobody")
    {
        bail!("A personalized account name is required");
    }
    Ok(())
}

impl Account {
    pub(super) fn validate(&self) -> Result<()> {
        validate_name(&self.short_name)?;
        if self.uid < 501
            || self.gid == 0
            || self.home != format!("/Users/{}", self.short_name)
            || self.home_inode == 0
        {
            bail!("Invalid personalized macOS account/home binding");
        }
        Ok(())
    }

    pub(super) fn installation(&self) -> Result<PathBuf> {
        self.validate()?;
        Ok(Path::new(&self.home).join(".terminalx-local"))
    }

    pub(super) fn check_current_home(&self) -> Result<()> {
        self.validate()?;
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) { bail!("Personalized bootstrap requires macOS arm64") }
        self.check_observed(&current_user()?, &Home::from(std::fs::symlink_metadata(&self.home)?), &self.installation()?)
    }

    pub(super) fn check_current(&self, base: &Path) -> Result<()> {
        self.validate()?;
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            bail!("Personalized account binding requires the macOS arm64 guest");
        }
        if dirs::home_dir().as_deref() != Some(Path::new(&self.home)) {
            bail!("Guest process home differs from its retained account");
        }
        let current = current_user()?;
        self.check_observed(
            &current,
            &Home::from(std::fs::symlink_metadata(&self.home)?),
            base,
        )?;
        // Reject substituted/symlinked installation directories before reading
        // a socket or dispatching any provider/desktop operation.
        let metadata = std::fs::symlink_metadata(base)?;
        if !metadata.is_dir() || metadata.uid() != self.uid || metadata.mode() & 0o077 != 0 {
            bail!("Personalized guest installation must be an owner-only directory");
        }
        Ok(())
    }

    fn check_observed(&self, current: &User, home: &Home, base: &Path) -> Result<()> {
        self.validate()?;
        if current.short_name != self.short_name
            || current.uid != self.uid
            || current.gid != self.gid
            || current.home != self.home
            || !home.directory
            || home.uid != self.uid
            || home.mode & 0o022 != 0
            || home.device != self.home_device
            || home.inode != self.home_inode
            || base != self.installation()?
        {
            bail!("Personalized guest account/home changed; no operation was routed");
        }
        Ok(())
    }
}

struct Home {
    directory: bool,
    uid: u32,
    mode: u32,
    device: u64,
    inode: u64,
}
impl From<std::fs::Metadata> for Home {
    fn from(value: std::fs::Metadata) -> Self {
        Self {
            directory: value.is_dir(),
            uid: value.uid(),
            mode: value.mode(),
            device: value.dev(),
            inode: value.ino(),
        }
    }
}

/// Unbound legacy installations are accepted only at the original lume path.
/// A personalized installation never degrades to legacy after losing its binding.
pub(super) fn check_installation_binding(base: &Path, account: Option<&Account>) -> Result<()> {
    if let Some(account) = account {
        account.check_current(base)
    } else if base == Path::new("/Users/lume/.terminalx-local") {
        Ok(())
    } else {
        bail!("Personalized installation has no retained account binding")
    }
}

pub(super) fn installation() -> Result<PathBuf> {
    let user = current_user()?;
    let home = Path::new(&user.home);
    home.file_name()
        .context("OS account home is not an account directory")?;
    Ok(home.join(".terminalx-local"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn personalized_binding_rejects_changed_account_home_and_inode() {
        let fixture = tempfile::tempdir().unwrap();
        let mut metadata = Home::from(std::fs::symlink_metadata(fixture.path()).unwrap());
        // Only the fixture observation is synthetic; no host account is touched.
        metadata.uid = 501;
        let account = Account {
            short_name: "personal".into(),
            uid: metadata.uid,
            gid: 20,
            home: "/Users/personal".into(),
            home_device: metadata.device,
            home_inode: metadata.inode,
        };
        let mut observed = User {
            short_name: account.short_name.clone(),
            uid: account.uid,
            gid: account.gid,
            home: account.home.clone(),
        };
        let base = account.installation().unwrap();
        account.check_observed(&observed, &metadata, &base).unwrap();
        observed.short_name = "replacement".into();
        assert!(account.check_observed(&observed, &metadata, &base).is_err());
        observed.short_name = account.short_name.clone();
        observed.uid += 1;
        assert!(account.check_observed(&observed, &metadata, &base).is_err());
        observed.uid = account.uid;
        observed.gid += 1;
        assert!(account.check_observed(&observed, &metadata, &base).is_err());
        observed.gid = account.gid;
        observed.home = "/Users/another".into();
        assert!(account.check_observed(&observed, &metadata, &base).is_err());
        observed.home = account.home.clone();
        let mut changed = account.clone();
        changed.home_inode += 1;
        assert!(changed.check_observed(&observed, &metadata, &base).is_err());
        changed = account.clone();
        changed.home_device += 1;
        assert!(changed.check_observed(&observed, &metadata, &base).is_err());
        assert!(account
            .check_observed(
                &observed,
                &metadata,
                Path::new("/Users/lume/.terminalx-local")
            )
            .is_err());
        std::fs::set_permissions(fixture.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(account
            .check_observed(
                &observed,
                &Home::from(std::fs::symlink_metadata(fixture.path()).unwrap()),
                &base
            )
            .is_err());
        let link = fixture.path().join("link");
        std::os::unix::fs::symlink(fixture.path(), &link).unwrap();
        assert!(account
            .check_observed(
                &observed,
                &Home::from(std::fs::symlink_metadata(link).unwrap()),
                &base
            )
            .is_err());
    }

    #[test]
    fn default_accounts_and_missing_personalized_bindings_never_fall_back() {
        for name in [
            "lume",
            "root",
            "nobody",
            "../user",
            "name;cmd",
            "name space",
            "User",
        ] {
            assert!(validate_name(name).is_err());
        }
        check_installation_binding(Path::new("/Users/lume/.terminalx-local"), None).unwrap();
        assert!(
            check_installation_binding(Path::new("/Users/personal/.terminalx-local"), None)
                .is_err()
        );
    }
}
