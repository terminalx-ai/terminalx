//! Installing an agent's CLI and signing in to it from inside the app
//! (PRO-152), in a terminal the reader watches.
//!
//! Both steps are the provider's own: its official install script (a native
//! build, so a stock Mac needs no Node) and its CLI's own sign-in, which opens
//! the browser itself. TerminalX adds a thin wrapper around each, so the end
//! of a step says what went wrong in a way the app can explain:
//!
//! - before the download, every folder the installer writes must be writable
//!   or creatable ([`exit::NO_PERMISSION`]);
//! - the script is fetched with `curl` first, so a network that cannot reach
//!   the provider ([`exit::OFFLINE`]) is told apart from a download that was
//!   refused or came back as something else ([`exit::DOWNLOAD`]);
//! - a step that fails afterwards asks the provider once more: no answer is
//!   [`exit::OFFLINE`], an answer is the step's own failure
//!   ([`exit::INSTALL`], [`exit::LOGIN`]).
//!
//! An exit from a signal (128 and over) is passed on as it is: the reader
//! closed the terminal, or something ended the program.
//!
//! The pane is `setup:<harness>:<run>` and belongs to no session. The webview
//! names only the agent and the step; the command is made here, from the
//! registry. Nothing here reads, copies or logs a credential: the CLI keeps
//! its login where it always does, and readiness is probed afterwards.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// The pane namespace of agent setup terminals, like `tab:` for an agent tab's own.
pub const PANE_NAMESPACE: &str = "setup";

/// How a setup step ended, beyond success (0) and a signal (128 and over).
/// The webview reads the same numbers (`src/lib/agentSetupFlow.ts`).
pub mod exit {
    /// A folder the installer writes cannot be written.
    pub const NO_PERMISSION: i32 = 70;
    /// The provider could not be reached.
    pub const OFFLINE: i32 = 71;
    /// The installer could not be downloaded, or was not an installer.
    pub const DOWNLOAD: i32 = 72;
    /// The installer ran and failed.
    pub const INSTALL: i32 = 73;
    /// The sign-in ran and did not finish.
    pub const LOGIN: i32 = 74;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Install,
    Login,
}

impl Step {
    pub fn parse(step: &str) -> Result<Self> {
        match step {
            "install" => Ok(Self::Install),
            "login" => Ok(Self::Login),
            _ => bail!("unknown setup step"),
        }
    }
}

/// Whether `id` is a setup pane for `harness`: `setup:<harness>:<run>`, the
/// run a short token of the webview's own.
pub fn is_pane(harness: &str, id: &str) -> bool {
    pane_harness(id) == Some(harness)
}

/// The agent a setup pane is for, if `id` is one.
pub fn pane_harness(id: &str) -> Option<&str> {
    let rest = id.strip_prefix(PANE_NAMESPACE)?.strip_prefix(':')?;
    let (harness, run) = rest.split_once(':')?;
    let token = |s: &str| !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    (token(harness) && token(run)).then_some(harness)
}

/// The command a setup pane runs for this step, made from the registry.
pub fn command(harness: &str, step: Step) -> Result<String> {
    let spec = super::REGISTRY.iter().find(|spec| spec.id == harness && super::visible(spec.id)).context("unknown agent")?;
    let Some(setup) = spec.setup.as_ref() else { bail!("{} cannot be installed from TerminalX. Follow its setup guide.", spec.name) };
    if cfg!(windows) {
        bail!("Installing {} from TerminalX is not supported on Windows. Follow its setup guide.", spec.name);
    }
    let home = dirs::home_dir().context("no home directory")?;
    Ok(match step {
        Step::Install => install_line(spec.name, setup.installer, setup.runner, &setup.writes.iter().map(|dir| home.join(dir)).collect::<Vec<_>>()),
        Step::Login => {
            // Just installed: the miss from before must not be believed.
            crate::binpath::invalidate();
            let Some(binary) = crate::binpath::resolve(spec.binary) else { bail!("{} is not installed.", spec.name) };
            login_line(spec.name, setup.probe, &binary, setup.login)
        }
    })
}

/// Arguments: the agent's name, the installer's address, how many folders
/// follow, the folders, then what runs the downloaded script.
///
/// The scripts are passed in single quotes through the user's login shell
/// (`$SHELL -l -c "exec …"`, `pty::Terminals::spawn`), so they hold no single
/// quote and no backslash: fish reads `\'` and `\\` even inside single quotes.
/// `@NAME@` is the [`exit`] code of that name.
const INSTALL: &str = r##"name=$1
url=$2
count=$3
shift 3
echo "==> Installing $name with its official installer"
echo "    $url"
echo
while [ "$count" -gt 0 ]; do
  dir=$1
  shift
  count=$((count - 1))
  at=$dir
  while [ ! -e "$at" ]; do at=$(dirname "$at"); done
  if [ ! -d "$at" ] || [ ! -w "$at" ]; then
    echo "$name cannot be installed: $at is not writable by $(id -un)." >&2
    exit @NO_PERMISSION@
  fi
done
tmp=$(mktemp -d "${TMPDIR:-/tmp}/terminalx-setup.XXXXXX") || exit @NO_PERMISSION@
cleanup() { rm -rf -- "$tmp"; }
trap cleanup EXIT
echo "==> Downloading the installer"
curl -fsSL --connect-timeout 20 -o "$tmp/install.sh" "$url"
status=$?
case $status in
  0) ;;
  5|6|7|28|35|52|55|56)
    echo "Could not reach $url. Check the internet connection, then try again." >&2
    exit @OFFLINE@ ;;
  *)
    echo "The installer could not be downloaded (curl exited with $status)." >&2
    exit @DOWNLOAD@ ;;
esac
case $(head -c 2 "$tmp/install.sh") in
  "#!") ;;
  *)
    echo "What came back from $url is not an installer." >&2
    exit @DOWNLOAD@ ;;
esac
echo "==> Running the installer"
"$@" "$tmp/install.sh"
status=$?
if [ "$status" -eq 0 ]; then
  echo
  echo "==> $name is installed"
  exit 0
fi
if [ "$status" -ge 128 ]; then exit "$status"; fi
if ! curl -fsSL --connect-timeout 10 -o /dev/null "$url"; then exit @OFFLINE@; fi
exit @INSTALL@
"##;

/// Arguments: the agent's name, a page to ask after a failure, then the
/// CLI and its sign-in arguments.
const LOGIN: &str = r#"name=$1
probe=$2
shift 2
echo "==> Signing in to $name"
echo "    Your browser opens to finish. If it does not, open the link below."
echo
"$@"
status=$?
if [ "$status" -eq 0 ]; then exit 0; fi
if [ "$status" -ge 128 ]; then exit "$status"; fi
if ! curl -fsSL --connect-timeout 10 -o /dev/null "$probe"; then exit @OFFLINE@; fi
exit @LOGIN@
"#;

fn install_line(name: &str, installer: &str, runner: &[&str], writes: &[PathBuf]) -> String {
    let mut args = vec![name.to_string(), installer.to_string(), writes.len().to_string()];
    args.extend(writes.iter().map(|dir| dir.to_string_lossy().into_owned()));
    args.extend(runner.iter().map(|word| word.to_string()));
    wrapped(INSTALL, &args)
}

fn login_line(name: &str, probe: &str, binary: &Path, login: &[&str]) -> String {
    let mut args = vec![name.to_string(), probe.to_string(), binary.to_string_lossy().into_owned()];
    args.extend(login.iter().map(|word| word.to_string()));
    wrapped(LOGIN, &args)
}

fn wrapped(script: &str, args: &[String]) -> String {
    debug_assert!(!script.contains(['\'', '\\']));
    let script = [("@NO_PERMISSION@", exit::NO_PERMISSION), ("@OFFLINE@", exit::OFFLINE), ("@DOWNLOAD@", exit::DOWNLOAD), ("@INSTALL@", exit::INSTALL), ("@LOGIN@", exit::LOGIN)]
        .iter()
        .fold(script.to_string(), |script, (name, code)| script.replace(name, &code.to_string()));
    debug_assert!(!script.contains("exit @"), "an exit code without a name");
    let mut line = format!("/bin/sh -c {} terminalx-setup", quote(&script));
    for arg in args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    line
}

/// One word for a POSIX shell (and fish): single quotes, a quote in it
/// closed, escaped and reopened.
fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r#"'\''"#))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_panes_name_their_agent_and_nothing_else_is_one() {
        assert_eq!(pane_harness("setup:claude:r1"), Some("claude"));
        assert!(is_pane("codex", "setup:codex:0f3a-9"));
        assert!(!is_pane("claude", "setup:codex:r1"));
        for id in ["setup:claude", "setup:claude:", "setup::r1", "setup:claude:r 1", "setup:claude:r1:x", "tab:abc", "01a0814c:1", "setupx:claude:r1"] {
            assert_eq!(pane_harness(id), None, "{id}");
        }
        // Not a shell tab of a session called "setup", either.
        assert!(!crate::pty::is_shell_id("setup:claude:r1"));
    }

    #[test]
    fn steps_parse_only_by_name() {
        assert_eq!(Step::parse("install").unwrap(), Step::Install);
        assert_eq!(Step::parse("login").unwrap(), Step::Login);
        assert!(Step::parse("rm -rf").is_err());
    }

    #[test]
    fn only_the_offered_agents_with_an_installer_are_installed_here() {
        for id in ["cursor", "opencode", "nope"] {
            assert!(command(id, Step::Install).is_err(), "{id}");
        }
        #[cfg(unix)]
        {
            let line = command("claude", Step::Install).unwrap();
            assert!(line.contains("'https://claude.ai/install.sh'"), "{line}");
            let line = command("codex", Step::Install).unwrap();
            assert!(line.contains("'https://chatgpt.com/codex/install.sh'") && line.contains("'CODEX_NON_INTERACTIVE=1'"), "{line}");
        }
    }

    #[test]
    fn the_wrapper_survives_quotes_in_its_arguments() {
        assert_eq!(quote("it's"), r#"'it'\''s'"#);
        let line = wrapped("echo \"$1\"", &["it's here".into()]);
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(&line).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "it's here\n");
    }

    #[cfg(unix)]
    mod e2e {
        //! install → sign in → ready, with a stubbed installer (PRO-152): the
        //! real wrapper in a real terminal through the login shell, `curl`
        //! fetching the stub over `file://`, the stub installing a stand-in
        //! CLI, its sign-in, and the readiness probe the app shows.

        use super::super::*;
        use crate::harness::readiness::{self, State};
        use crate::pty::{PaneSpec, Terminals};
        use crate::sink::{BroadcastSink, EventSink};
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        /// A stand-in `claude`: a version, a login status read from a file
        /// next to it, and a sign-in that writes that file.
        const FAKE_CLAUDE: &str = r#"#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
case "$1 $2" in
  "--version "*) echo "2.1.318 (Claude Code)" ;;
  "auth status") if [ -f "$here/.signed-in" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi ;;
  "auth login") echo "Opening the browser to sign in"; touch "$here/.signed-in" ;;
  *) exit 2 ;;
esac
"#;

        /// Each pane's exit, in the order they came.
        type Exits = Arc<Mutex<Vec<(String, Option<i32>)>>>;

        struct World {
            dir: tempfile::TempDir,
            sink: Arc<dyn EventSink>,
            exits: Exits,
            terminals: Terminals,
        }

        impl World {
            fn new() -> Self {
                let dir = tempfile::tempdir().unwrap();
                std::fs::create_dir_all(dir.path().join("home")).unwrap();
                // What the provider's script would do: put the CLI in ~/.local/bin.
                std::fs::write(dir.path().join("fake-claude"), FAKE_CLAUDE).unwrap();
                std::fs::write(
                    dir.path().join("install.sh"),
                    format!("#!/bin/sh\nset -e\necho \"downloading claude-darwin-arm64\"\nmkdir -p \"$HOME/.local/bin\"\ncp '{}' \"$HOME/.local/bin/claude\"\nchmod +x \"$HOME/.local/bin/claude\"\n", dir.path().join("fake-claude").display()),
                )
                .unwrap();
                std::fs::write(dir.path().join("broken.sh"), "#!/bin/sh\necho 'Checksum verification failed' >&2\nexit 1\n").unwrap();
                std::fs::write(dir.path().join("page.html"), "<html>blocked</html>\n").unwrap();
                let sink = Arc::new(BroadcastSink::new(64));
                let exits: Exits = Arc::default();
                let seen = exits.clone();
                sink.listen("pty_exit", Box::new(move |payload| {
                    let exit: crate::pty::PtyExit = serde_json::from_str(payload).unwrap();
                    seen.lock().unwrap().push((exit.id, exit.code));
                }));
                Self { dir, sink, exits, terminals: Terminals::new() }
            }

            fn home(&self) -> PathBuf {
                self.dir.path().join("home")
            }

            fn url(&self, file: &str) -> String {
                format!("file://{}", self.dir.path().join(file).display())
            }

            /// Run one step in `id`, in the place of the step before, as the
            /// runtime does, and wait for its exit code.
            fn run(&self, id: &str, command: &str) -> Option<i32> {
                let home = self.home().to_string_lossy().into_owned();
                let env = [("HOME".to_string(), home.clone())];
                let before = self.exits.lock().unwrap().len();
                self.terminals.respawn(self.sink.clone(), id, PaneSpec { cwd: &home, cols: 100, rows: 24, command: Some(command), env: &env }).unwrap();
                let deadline = Instant::now() + Duration::from_secs(60);
                loop {
                    if let Some((_, code)) = self.exits.lock().unwrap()[before..].iter().find(|(pane, _)| pane == id) {
                        return *code;
                    }
                    assert!(Instant::now() < deadline, "{id} did not finish: {}", self.output(id));
                    std::thread::sleep(Duration::from_millis(20));
                }
            }

            fn install(&self, id: &str, installer: &str) -> Option<i32> {
                let writes = [".local/bin", ".local/share/claude", ".claude"].map(|dir| self.home().join(dir));
                self.run(id, &install_line("Claude Code", installer, &["sh"], &writes))
            }

            fn output(&self, id: &str) -> String {
                String::from_utf8_lossy(&self.terminals.read_output(id).unwrap_or_default()).into_owned()
            }
        }

        #[test]
        fn install_then_sign_in_then_ready_in_one_terminal() {
            let world = World::new();
            let claude = world.home().join(".local/bin/claude");
            assert_eq!(readiness::check_binary("claude", None).state, State::Missing);

            assert_eq!(world.install("setup:claude:r1", &world.url("install.sh")), Some(0), "{}", world.output("setup:claude:r1"));
            assert!(claude.metadata().unwrap().permissions().mode() & 0o111 != 0);
            let installed = readiness::check_binary("claude", Some(claude.to_string_lossy().into_owned()));
            assert_eq!((installed.state, installed.version.as_deref()), (State::SignedOut, Some("2.1.318")));

            // Sign-in follows in the same terminal: what the installer printed stays above it.
            let login = login_line("Claude Code", &world.url("install.sh"), &claude, &["auth", "login"]);
            assert_eq!(world.run("setup:claude:r1", &login), Some(0));
            let output = world.output("setup:claude:r1");
            let (installing, signing_in) = (output.find("downloading claude-darwin-arm64").unwrap(), output.find("Opening the browser to sign in").unwrap());
            assert!(installing < signing_in, "{output}");
            assert!(output.contains("==> Claude Code is installed"), "{output}");
            assert_eq!(readiness::check_binary("claude", Some(claude.to_string_lossy().into_owned())).state, State::Ready);
            world.terminals.kill_all();
        }

        #[test]
        fn each_failure_ends_with_its_own_code() {
            let world = World::new();
            // Nothing listens on port 9 here: the network cannot reach the provider.
            assert_eq!(world.install("setup:claude:offline", "http://127.0.0.1:9/install.sh"), Some(exit::OFFLINE), "{}", world.output("setup:claude:offline"));
            assert!(world.output("setup:claude:offline").contains("Check the internet connection"));
            // Refused, and something that is not an installer (a captive portal's page).
            assert_eq!(world.install("setup:claude:gone", &world.url("missing.sh")), Some(exit::DOWNLOAD));
            assert_eq!(world.install("setup:claude:html", &world.url("page.html")), Some(exit::DOWNLOAD));
            // The script ran and failed, while the provider still answers.
            assert_eq!(world.install("setup:claude:broken", &world.url("broken.sh")), Some(exit::INSTALL));
            assert!(world.output("setup:claude:broken").contains("Checksum verification failed"));
            // A sign-in that does not finish.
            let failing = login_line("Claude Code", &world.url("install.sh"), Path::new("/usr/bin/false"), &[]);
            assert_eq!(world.run("setup:claude:login", &failing), Some(exit::LOGIN));
            let offline = login_line("Claude Code", "http://127.0.0.1:9/", Path::new("/usr/bin/false"), &[]);
            assert_eq!(world.run("setup:claude:login-offline", &offline), Some(exit::OFFLINE));
            // A folder it must write that is not writable: nothing is downloaded.
            std::fs::create_dir_all(world.home().join(".claude")).unwrap();
            std::fs::set_permissions(world.home().join(".claude"), std::fs::Permissions::from_mode(0o555)).unwrap();
            if std::fs::write(world.home().join(".claude/probe"), "").is_ok() {
                eprintln!("skipped the permission case: running as a user who writes anywhere");
            } else {
                assert_eq!(world.install("setup:claude:denied", &world.url("install.sh")), Some(exit::NO_PERMISSION));
                let output = world.output("setup:claude:denied");
                assert!(output.contains("is not writable by") && !output.contains("Downloading"), "{output}");
                assert!(!world.home().join(".local/bin/claude").exists());
            }
            std::fs::set_permissions(world.home().join(".claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
            world.terminals.kill_all();
        }
    }
}
