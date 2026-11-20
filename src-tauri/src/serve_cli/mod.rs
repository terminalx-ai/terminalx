//! `terminalx-serve` commands a person runs on a headless server (PRO-353):
//! `service`, `pair`, `devices`, `projects`, `login`, `logout` and `update`. Each lives in
//! its own module; this one only dispatches, and holds what they share: the
//! install layout, the default data directory and the key runtime releases
//! are signed with.
//!
//! Install layout (written by `scripts/install/install.sh` and `update`):
//!
//! ```text
//! ~/.terminalx/
//!   versions/<version>/terminalx-serve   one folder per installed version
//!   current -> versions/<version>        swapped atomically on install and update
//!   data/                                the runtime's data directory (TERMINALX_HOME)
//!   logs/runtime.log                     the service's log
//! ```
//!
//! The service runs `~/.terminalx/current/terminalx-serve --data-dir
//! ~/.terminalx/data --log-file ~/.terminalx/logs/runtime.log`. Every command
//! here finds the same data directory: `--data-dir`, else `TERMINALX_HOME`,
//! else [`default_data_dir`]. The desktop app's `~/.raccoon` is never used.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

#[cfg(unix)]
pub mod consent;
#[cfg(windows)]
#[path = "consent_windows.rs"]
pub mod consent;
pub mod control_client;
pub mod devices;
#[cfg(unix)]
pub mod handover;
pub mod login;
pub mod pair;
pub mod projects;
pub mod service;
pub mod update;

/// The folder under the home directory that holds a headless install.
pub const INSTALL_DIR: &str = ".terminalx";

/// The key runtime releases are signed with: an OpenSSH Ed25519 public key.
/// `SHA256SUMS` of each runtime release is signed with it as an SSH signature
/// (`ssh-keygen -Y sign -n` [`SIGNATURE_NAMESPACE`]), published as
/// `SHA256SUMS.sig`. `scripts/install/allowed_signers` holds the same key for
/// the installer; the two must stay equal (a test checks).
pub const RUNTIME_SIGNING_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ17UcQnKdE/Sp6oQBa8SGenmiS0ufw6xO8CrY6J/MEU";

/// The SSH signature namespace of runtime releases.
pub const SIGNATURE_NAMESPACE: &str = "terminalx-runtime";

/// The principal the installer's `allowed_signers` names.
pub const SIGNER_PRINCIPAL: &str = "release@terminalx";

/// The longest Unix socket path the runtime may bind (`sun_path` is 104
/// bytes on macOS, with its terminating NUL).
const SOCKET_PATH_LIMIT: usize = 103;

/// The longest socket name the runtime puts in `<data dir>/run/`
/// (`hooks-<pid>.sock`, pids up to 2^22 on Linux, 99999 on macOS).
const LONGEST_SOCKET: &str = "run/hooks-4194304.sock";

/// `~/.terminalx`.
pub fn install_root() -> Result<PathBuf> {
    Ok(dirs::home_dir().context("this user has no home directory")?.join(INSTALL_DIR))
}

/// `~/.terminalx/data`: the data directory of a headless install, short
/// enough for the runtime's sockets under any ordinary home directory.
pub fn default_data_dir() -> Result<PathBuf> {
    Ok(install_root()?.join("data"))
}

/// The data directory a command works on: `flag`, else `TERMINALX_HOME`,
/// else [`default_data_dir`]. Refuses one whose sockets would not fit.
pub fn resolve_data_dir(flag: Option<&Path>) -> Result<PathBuf> {
    let dir = match (flag, crate::store::state_home_env()) {
        (Some(dir), _) => dir.to_path_buf(),
        (None, Some(home)) => PathBuf::from(home),
        (None, None) => default_data_dir()?,
    };
    check_socket_room(&dir)?;
    Ok(dir)
}

/// Whether the runtime's sockets fit under `dir`.
pub fn check_socket_room(dir: &Path) -> Result<()> {
    let longest = dir.join(LONGEST_SOCKET);
    let length = longest.as_os_str().len();
    if length > SOCKET_PATH_LIMIT {
        bail!(
            "the data directory {} is too long for the runtime's sockets ({length} bytes, at most {SOCKET_PATH_LIMIT}); choose a shorter --data-dir",
            dir.display()
        );
    }
    Ok(())
}

/// Run a headless command if `args` names one. Returns the exit code, or
/// `None` for anything else (the runtime itself, hooks and other helpers).
pub fn run(args: &[String]) -> Option<i32> {
    let rest = args.get(1..).unwrap_or_default();
    let code = match args.first().map(String::as_str)? {
        "service" => service::run(rest),
        "pair" => pair::run(rest),
        "devices" => devices::run(rest),
        #[cfg(unix)]
        "projects" => projects::run(rest),
        "login" => login::run(rest),
        "logout" => login::run_logout(rest),
        "update" => update::run(rest),
        _ => return None,
    };
    Some(code)
}

/// The usage lines for these commands, appended to `terminalx-serve --help`.
pub const USAGE: &str = "\
Commands on a headless server:
  service install|status|uninstall   Run the runtime as a user service that
                                     starts at boot (systemd on Linux, a
                                     LaunchAgent on macOS)
  pair                               Let another computer operate this one:
                                     shows a one-time code and asks Allow? [y/N]
  devices [revoke <id>]              List or remove the computers that may
                                     operate this one
  projects [add <folder>]            List the projects paired computers see, or
                                     add a folder (a Git clone) as one
  login | logout                     Sign in to your TerminalX account with a
                                     device code, for the relay route
  update                             Install the newest signed runtime

Each takes --data-dir <dir>; the default is ~/.terminalx/data.";

/// `--data-dir <dir>` (or `--data-dir=<dir>`) from a command's arguments,
/// and the arguments left over.
pub fn take_data_dir(args: &[String]) -> Result<(Option<PathBuf>, Vec<String>)> {
    let mut dir = None;
    let mut rest = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--data-dir=") {
            dir = Some(PathBuf::from(value));
        } else if arg == "--data-dir" {
            let value = args.next().filter(|value| !value.is_empty()).context("--data-dir needs a value")?;
            dir = Some(PathBuf::from(value));
        } else {
            rest.push(arg.clone());
        }
    }
    Ok((dir, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_home_length_data_dir_has_room_for_its_sockets() {
        check_socket_room(Path::new("/home/someone-with-a-long-name/.terminalx/data")).unwrap();
        let long = format!("/home/{}/.terminalx/data", "x".repeat(80));
        assert!(check_socket_room(Path::new(&long)).is_err());
    }

    #[test]
    fn takes_the_data_dir_in_either_form() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        let (dir, rest) = take_data_dir(&args(&["--data-dir", "/srv/tx", "revoke", "c1"])).unwrap();
        assert_eq!(dir.as_deref(), Some(Path::new("/srv/tx")));
        assert_eq!(rest, args(&["revoke", "c1"]));
        let (dir, _) = take_data_dir(&args(&["--data-dir=/srv/tx"])).unwrap();
        assert_eq!(dir.as_deref(), Some(Path::new("/srv/tx")));
        assert!(take_data_dir(&args(&["--data-dir"])).is_err());
    }

    #[test]
    fn unknown_commands_are_left_to_the_runtime() {
        assert_eq!(run(&["--self-test".to_string()]), None);
        assert_eq!(run(&[]), None);
    }

    #[test]
    fn the_installer_trusts_the_same_key() {
        let signers = include_str!("../../../scripts/install/allowed_signers");
        let line = signers.lines().find(|line| !line.trim().is_empty() && !line.starts_with('#')).expect("a signer");
        assert_eq!(line.trim(), format!("{SIGNER_PRINCIPAL} namespaces=\"{SIGNATURE_NAMESPACE}\" {RUNTIME_SIGNING_KEY}"));
    }
}
