//! The legacy guest route through TerminalX's pinned Cua and Lume, held to the
//! commands that never reach Lume's SSH. Pinned Cua (`cua-sdk-v0.7.0`) reaches
//! a guest's `cua-spacesd` over the network for `sb exec` and `sb cp`, and runs
//! `lume ssh` only when:
//! - `sb exec` has none of `-i`, `--user`, `--cwd` or `--timeout` and the guest
//!   has no `cua-spacesd` (`sandbox.rs`, `exec_agentless`);
//! - `sb shell`, `view` or a screenshot finds no `cua-spacesd`;
//! - a create's start spec carries an environment: `--env`, or the
//!   `env-applied` marker an earlier start left (`lume/mod.rs`, `sync_macos_env`).
//!
//! Without `--embedded` it also hands commands to any running cua daemon, which
//! may be another build. `lume ssh` falls back from its built-in client to
//! `/usr/bin/ssh`, which reads the user's ssh_config, so that config could
//! forward an agent, ports or environment to the guest. `check` refuses, before
//! Cua runs, every legacy command that could take one of those paths.
use super::{bootstrap, journal};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// What the legacy route would run with.
pub(super) struct Route {
    /// TerminalX's prepared Cua and Lume are present and verified.
    pub(super) pinned: bool,
    /// Pinned Cua's home: `$CUA_HOME`, or `$HOME/.cua` (cua-vmm `cua_home`).
    pub(super) cua_home: PathBuf,
}

impl Route {
    /// The route as a Cua child of this process would see it: the child keeps
    /// this process's `HOME` and `CUA_HOME`.
    pub(super) fn current() -> Result<Self> {
        let pinned = bootstrap::installed("cua")?.is_some() && bootstrap::installed("lume")?.is_some();
        let cua_home = match std::env::var_os("CUA_HOME").filter(|h| !h.is_empty()) {
            Some(home) => PathBuf::from(home),
            None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".cua"),
        };
        Ok(Self { pinned, cua_home })
    }

    /// The pinned start-environment marker for VM `name`.
    fn env_marker(&self, name: &str) -> PathBuf {
        self.cua_home.join("vmm").join("lume").join(name).join("env-applied")
    }
}

const UNPINNED: &str = "Legacy guest commands run only through TerminalX's pinned Cua and Lume, whose guest route never uses SSH. Prepare them in this environment's setup (the tools step); no guest command was sent";

/// The argv for Cua: `--embedded` first, so no daemon of another build runs
/// it. Refuses, before anything runs, a command that could reach `lume ssh`
/// or that this route does not use.
pub(super) fn check(route: &Route, args: &[&str]) -> Result<Vec<String>> {
    match args {
        ["sb", "resume" | "suspend" | "rm" | "info" | "ls", ..] | ["runtime", "doctor", ..] => {}
        ["sb", "exec", rest @ ..] => {
            // `-i` streams through the guest's cua-spacesd; pinned Cua never
            // takes its SSH path with it.
            if !matches!(rest, ["-i", _, "--", _, ..]) {
                bail!("A legacy guest command must stream through the guest's cua-spacesd (`sb exec -i`); otherwise Cua could run it over `lume ssh`. No guest command was sent")
            }
            pinned(route)?;
        }
        ["sb", "cp", _, _] => pinned(route)?,
        ["sb", "create", rest @ ..] => {
            if rest.iter().any(|a| *a == "--env" || a.starts_with("--env=")) {
                bail!("A legacy VM is never created with a Cua environment: Cua would write it over `lume ssh`. No VM was created")
            }
            let name = rest
                .iter()
                .position(|a| *a == "--name")
                .and_then(|i| rest.get(i + 1))
                .filter(|n| journal::validate_sandbox(&format!("local:{n}")).is_ok())
                .ok_or_else(|| anyhow::anyhow!("A legacy VM create needs its exact VM name; no VM was created"))?;
            pinned(route)?;
            let marker = route.env_marker(name);
            if marker_present(&marker)? {
                bail!(
                    "Cua kept an environment for a VM named {name} ({}), so creating it would write that environment over `lume ssh`, whose fallback reads your ssh_config. No VM was created",
                    marker.display()
                )
            }
        }
        _ => bail!("This Cua command is not part of the legacy guest route; nothing was run"),
    }
    Ok(std::iter::once("--embedded").chain(args.iter().copied()).map(String::from).collect())
}

fn pinned(route: &Route) -> Result<()> {
    if !route.pinned {
        bail!("{UNPINNED}")
    }
    Ok(())
}

fn marker_present(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        // Unreadable state cannot show the marker is absent.
        Err(error) => bail!("Cua's state for this VM is unreadable ({error}); no VM was created"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(pinned: bool) -> (tempfile::TempDir, Route) {
        let home = tempfile::tempdir().unwrap();
        let route = Route { pinned, cua_home: home.path().join(".cua") };
        (home, route)
    }
    /// The exact shapes TerminalX sends today (`host.rs`, `supervisor.rs`, `provisioning.rs`).
    fn current_commands() -> Vec<Vec<&'static str>> {
        vec![
            vec!["sb", "exec", "-i", "local:guest", "--", "/Users/lume/.terminalx-local/bin/terminalx-serve", "local-vm-rpc", "-"],
            vec!["sb", "exec", "-i", "local:guest", "--", "/bin/sh", "-c", "printf guest-ok"],
            vec!["sb", "cp", "/private/tmp/archive.tar.gz", "local:guest:/Users/lume/.terminalx-local/staging/driver.tar.gz"],
            vec!["sb", "create", "macos-tahoe-cua:latest", "--on", "local", "--kind", "vm", "--runtime", "lume", "--name", "guest",
                "--cpu", "4", "--memory", "8GB", "--keep-on-failure", "--json"],
            vec!["sb", "info", "local:guest", "--json"],
            vec!["sb", "ls", "--local", "--json"],
            vec!["sb", "resume", "local:guest"],
            vec!["sb", "suspend", "local:guest"],
            vec!["sb", "rm", "local:guest", "--force"],
            vec!["runtime", "doctor", "--json"],
        ]
    }

    #[test]
    fn todays_commands_run_embedded_with_their_arguments_unchanged() {
        let (_home, route) = route(true);
        for args in current_commands() {
            let checked = check(&route, &args).unwrap();
            assert_eq!(checked[0], "--embedded", "{args:?}");
            assert_eq!(&checked[1..], args.iter().map(|a| a.to_string()).collect::<Vec<_>>().as_slice());
        }
    }

    #[test]
    fn an_unpinned_cua_or_lume_never_reaches_a_guest_but_vm_state_stays_readable() {
        let (_home, route) = route(false);
        for args in current_commands() {
            let reaches_guest = matches!(args[..2], ["sb", "exec" | "cp" | "create"]);
            let result = check(&route, &args);
            assert_eq!(result.is_err(), reaches_guest, "{args:?}");
            if reaches_guest {
                assert!(format!("{:#}", result.unwrap_err()).contains("pinned Cua and Lume"));
            }
        }
    }

    #[test]
    fn every_route_to_lume_ssh_is_refused() {
        let (_home, route) = route(true);
        for args in [
            vec!["sb", "exec", "local:guest", "--", "uname"],
            vec!["sb", "exec", "local:guest", "-i", "--", "uname"],
            vec!["sb", "exec", "-i", "local:guest", "uname"],
            vec!["sb", "exec", "-i"],
            vec!["sb", "shell", "local:guest"],
            vec!["sb", "view", "local:guest"],
            vec!["sb", "screenshot", "local:guest"],
            vec!["sb", "ssh", "local:guest"],
            vec!["sb", "create", "image", "--name", "guest", "--env", "A=b"],
            vec!["sb", "create", "image", "--name", "guest", "--env=A=b"],
            vec!["sb", "create", "image", "--on", "local"],
            vec!["sb", "create", "image", "--name", "../escape"],
            vec!["sb", "cp", "a", "b", "c"],
            vec!["daemon", "start"],
            vec!["--daemon", "sock", "sb", "ls"],
            vec![],
        ] {
            assert!(check(&route, &args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn a_kept_cua_environment_for_the_name_refuses_the_create_only() {
        let (_home, route) = route(true);
        let create = ["sb", "create", "image", "--name", "guest", "--json"];
        let marker = route.env_marker("guest");
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, b"").unwrap();
        let error = format!("{:#}", check(&route, &create).unwrap_err());
        assert!(error.contains("named guest") && error.contains("env-applied") && error.contains("No VM was created"), "{error}");
        assert!(marker.exists(), "Cua's state is never changed");
        // Another VM's environment does not concern this one.
        check(&route, &["sb", "create", "image", "--name", "other"]).unwrap();
        check(&route, &["sb", "exec", "-i", "local:guest", "--", "true"]).unwrap();
    }

    /// Through `host::cua` itself: without TerminalX's prepared tools a guest
    /// command, and any command outside the route, is refused before Cua is
    /// even resolved. (VM-state commands are not run here: that would start
    /// whatever Cua this machine has installed.)
    #[test]
    fn host_cua_refuses_before_dispatch_without_the_pinned_tools() {
        let _home = crate::store::temp_home();
        assert!(!Route::current().unwrap().pinned);
        let budget = std::time::Duration::from_secs(5);
        for args in [&["sb", "exec", "-i", "local:guest", "--", "true"][..], &["sb", "cp", "/private/tmp/a", "local:guest:/tmp/a"],
            &["sb", "create", "image", "--name", "guest"], &["sb", "exec", "local:guest", "--", "true"]]
        {
            let error = format!("{:#}", super::super::host::cua(args, b"", budget).unwrap_err());
            let error = error.to_lowercase();
            assert!(error.contains("no guest command was sent") || error.contains("no vm was created"), "{args:?}: {error}");
        }
        let error = format!("{:#}", super::super::host::cua(&["sb", "shell", "local:guest"], b"", budget).unwrap_err());
        assert!(error.contains("not part of the legacy guest route"), "{error}");
    }

    #[test]
    fn the_route_follows_cua_home_as_the_child_sees_it() {
        let (home, route) = route(true);
        assert_eq!(route.env_marker("guest"), home.path().join(".cua/vmm/lume/guest/env-applied"));
    }
}
