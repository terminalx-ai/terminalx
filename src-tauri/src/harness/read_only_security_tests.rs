//! Executable reproductions from PRO-198's security reviews.
use super::*;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

struct Repository {
    _temp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    git: PathBuf,
    execution: Execution,
}

impl Repository {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let execution = isolated_execution(&home);
        let repo = Self {
            _temp: temp,
            root,
            home,
            git: which::which("git").unwrap(),
            execution,
        };
        repo.run(&repo.home, &["init", "-q", repo.root.to_str().unwrap()]);
        repo.run(
            &repo.root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        );
        repo
    }

    fn run(&self, cwd: &Path, args: &[&str]) -> Output {
        let output = self
            .execution
            .git(&self.git)
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn approved_at(&self, command: &str, cwd: &Path) -> Option<Approved> {
        approved_in(
            "Bash",
            &serde_json::json!({"command":command}),
            cwd.to_str(),
            &self.execution,
        )
    }

    fn approved(&self, command: &str) -> Option<Approved> {
        self.approved_at(command, &self.root)
    }

    fn helper(&self, name: &str, body: &str) -> PathBuf {
        let path = self.home.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn signed_commit(&self) {
        let tree = self.run(&self.root, &["rev-parse", "HEAD^{tree}"]);
        let tree = String::from_utf8(tree.stdout).unwrap();
        let content = format!("tree {}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nsigned fixture\n", tree.trim());
        let mut child = self
            .execution
            .git(&self.git)
            .current_dir(&self.root)
            .args(["hash-object", "-t", "commit", "-w", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(content.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let id = String::from_utf8(output.stdout).unwrap();
        self.run(&self.root, &["update-ref", "HEAD", id.trim()]);
    }
}

#[test]
fn git_optional_values_never_hide_a_following_output_option() {
    let repo = Repository::new();
    for args in [
        vec!["diff", "-U", "--output=target"],
        vec!["log", "--pretty", "--output=target"],
        vec!["diff", "--unified", "--output=target"],
        vec!["diff", "--color", "--output=target"],
    ] {
        let command = format!("git {}", args.join(" "));
        assert!(repo.approved(&command).is_none(), "{command}");
        assert!(
            !repo.root.join("target").exists(),
            "validation must not execute the command"
        );
        // Prove this is a real writing invocation, not just invalid Git syntax.
        repo.run(&repo.root, &args);
        assert!(
            repo.root.join("target").exists(),
            "{command} did not reproduce the write"
        );
        std::fs::remove_file(repo.root.join("target")).unwrap();
    }
    for command in [
        "git log --format --output=target",
        "git diff -U--output=target",
        "git log -n --output=target",
        "git log -n--output=target",
    ] {
        assert!(repo.approved(command).is_none(), "{command}");
    }
    for command in [
        "git diff -U",
        "git diff -U3 --stat",
        "git diff --unified=5",
        "git log --pretty --stat",
        "git log --pretty=oneline",
        "git log -n 2",
        "git log -n2",
        "git status -u --short",
    ] {
        assert!(repo.approved(command).is_some(), "{command}");
    }
}

#[test]
fn submodules_with_separate_helper_config_require_approval_even_from_a_subdirectory() {
    let repo = Repository::new();
    let sub = Repository::new();
    repo.run(
        &repo.root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub.root.to_str().unwrap(),
            "child",
        ],
    );
    let marker = repo.home.join("submodule-marker");
    let helper = repo.helper(
        "fsmonitor",
        &format!(": > {}\nprintf 'token\\0'", quote(marker.to_str().unwrap())),
    );
    repo.run(
        &repo.root.join("child"),
        &["config", "core.fsmonitor", helper.to_str().unwrap()],
    );
    // Do not rely on .gitmodules being present: tracked gitlinks are what Git traverses.
    std::fs::remove_file(repo.root.join(".gitmodules")).unwrap();
    let directory = repo.root.join("source");
    std::fs::create_dir(&directory).unwrap();
    for cwd in [&repo.root, &directory] {
        assert!(repo.approved_at("git status --short", cwd).is_none());
        assert!(repo.approved_at("git diff --stat", cwd).is_none());
    }
    assert!(
        !marker.exists(),
        "config inspection must not run a submodule helper"
    );
    repo.run(&repo.root, &["status", "--short"]);
    assert!(
        marker.exists(),
        "fixture must reproduce the submodule helper execution"
    );
    // The injected fsmonitor override is also inherited by nested Git
    // commands, independent of the conservative gitlink approval check.
    std::fs::remove_file(&marker).unwrap();
    repo.run(
        &repo.root,
        &["-c", "core.fsmonitor=false", "status", "--short"],
    );
    assert!(!marker.exists());
}

#[test]
fn configured_default_and_named_pretty_formats_cannot_start_gpg() {
    for (key, command, args) in [
        ("format.pretty", "git log", vec!["log"]),
        (
            "pretty.checksig",
            "git log --pretty=checksig",
            vec!["log", "--pretty=checksig"],
        ),
    ] {
        let repo = Repository::new();
        repo.signed_commit();
        let marker = repo.home.join("gpg-marker");
        let helper = repo.helper(
            "gpg-helper",
            &format!(": > {}\nexit 1", quote(marker.to_str().unwrap())),
        );
        repo.run(
            &repo.root,
            &["config", "gpg.program", helper.to_str().unwrap()],
        );
        assert!(repo.approved("git log --oneline").is_some());
        repo.run(&repo.root, &["config", key, "%G?"]);
        assert!(repo.approved(command).is_none(), "{key}");
        assert!(!marker.exists());
        repo.run(&repo.root, &args);
        assert!(
            marker.exists(),
            "fixture must invoke the configured GPG helper: {key}"
        );
    }
}


/// The shell a payload is written for.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Shell {
    Zsh,
    Bash,
}

/// A way for shell startup to run code before, or instead of, a command
/// typed into that shell.
struct Payload {
    name: &'static str,
    /// Startup-file text that writes the marker when it runs.
    startup: String,
    /// A command typed into the startup shell that shows the payload is
    /// live. None where this platform cannot show it: glibc's loader
    /// variables do nothing on macOS.
    control: Option<&'static str>,
}

/// The four ways in that PRO-330's review reproduced on main, then the
/// earlier reviews' tricks against the in-shell guard (PRO-267). Every one
/// writes only to `marker` (or, for the loader, `marker.<pid>`). `namerefs`
/// is whether this bash has them (not macOS's 3.2).
fn payloads(shell: Shell, marker: &Path, namerefs: bool) -> Vec<Payload> {
    let m = quote(marker.to_str().unwrap());
    let function = |name: &str, body: &str| match shell {
        Shell::Zsh => format!("{}() {{ {body} }}\n", quote(name)),
        // Bash accepts a slash in a function name outside POSIX mode. Export
        // it too, in case anything the shell launches would import it.
        Shell::Bash => format!("function {name} {{ {body} }}\nexport -f {name} 2>/dev/null\n"),
    };
    let xtrace = match shell {
        Shell::Zsh => format!("setopt promptsubst xtrace\nPS4={}\nexport PS4\n", quote(&format!("$(: > {m})"))),
        Shell::Bash => format!("PS4={}\nexport PS4\nset -x\nexport SHELLOPTS\n", quote(&format!("$(: > {m})"))),
    };
    let mut builtins = String::new();
    for name in ["unset", "builtin", "command", "false", "exit", "true", ":", "trap"] {
        builtins.push_str(&format!("{name}() {{ printf invoked > {m}; }}\n"));
    }
    let mut payloads = vec![
        Payload {
            name: "a function named /usr/bin/env",
            startup: function("/usr/bin/env", &format!(": > {m};")),
            control: Some("'/usr/bin/env' '-i' '/bin/sh' '-c' 'exit 0'"),
        },
        Payload {
            name: "readonly exported loader variables",
            startup: format!("readonly LD_DEBUG=files LD_DEBUG_OUTPUT={m}\nexport LD_DEBUG LD_DEBUG_OUTPUT\n"),
            control: cfg!(target_os = "linux").then_some("'/usr/bin/env' 'true'"),
        },
        Payload {
            name: "a function named /bin/test that returns 0",
            startup: function("/bin/test", &format!(": > {m}; return 0;")),
            control: Some("'/bin/test' '.' '-ef' '/'"),
        },
        Payload {
            name: "an xtrace prompt with a command in it",
            startup: xtrace,
            control: Some("'/usr/bin/true'"),
        },
        Payload {
            name: "a DEBUG trap",
            startup: format!("trap {} DEBUG\n", quote(&format!(": > {m}"))),
            control: Some("'/usr/bin/true'"),
        },
        Payload {
            name: "a function for each cleanup builtin",
            startup: builtins,
            control: Some("unset LD_PRELOAD"),
        },
        Payload {
            name: "an error trap",
            startup: match shell {
                Shell::Zsh => format!("TRAPZERR() {{ : > {m}; }}\n"),
                Shell::Bash => format!("trap {} ERR\n", quote(&format!(": > {m}"))),
            },
            // A second command: bash execs a lone `-c` command, trap and all.
            control: Some("'/usr/bin/false'; '/usr/bin/true'"),
        },
    ];
    if shell == Shell::Zsh {
        // Global aliases expand on any bare word, including after `<&`.
        let mut aliases = String::new();
        for word in ["0", "8", "-"] {
            aliases.push_str(&format!("alias -g -- {}\n", quote(&format!("{word}={word}; printf invoked > {m}; :"))));
        }
        payloads.push(Payload { name: "global aliases on descriptor words", startup: aliases, control: Some("'/usr/bin/true' 8<&0 0<&8 8<&-") });
    }
    if shell == Shell::Bash && namerefs {
        // Even a presence test of a name follows a nameref and evaluates
        // its subscript.
        payloads.push(Payload {
            name: "a nameref on a loader variable",
            startup: format!("declare -a target\ndeclare -n LD_TRACE_LOADED_OBJECTS={}\n", quote(&format!("target[$(: > {m}; printf 0)]"))),
            control: Some("'/usr/bin/printf' '%s' \"${LD_TRACE_LOADED_OBJECTS+present}\""),
        });
    }
    payloads
}

/// PRO-198's exported tool settings: a ripgrep preprocessor, Git tracing
/// and an injected fsmonitor, each writing the marker.
fn tool_payload(repo: &Repository, marker: &Path) -> Payload {
    let helper = repo.helper(
        "preprocessor",
        &format!(": > {}\ncat \"$1\"", quote(marker.to_str().unwrap())),
    );
    let config = repo.home.join("rg-config");
    std::fs::write(&config, format!("--pre\n{}\n", helper.display())).unwrap();
    let mut startup = format!(
        "export RIPGREP_CONFIG_PATH={}\nexport GIT_TRACE={}\nexport GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0=core.fsmonitor\nexport GIT_CONFIG_VALUE_0={}\n",
        quote(config.to_str().unwrap()),
        quote(marker.to_str().unwrap()),
        quote(helper.to_str().unwrap())
    );
    if let Ok(rg) = which::which("rg") {
        startup.push_str(&format!("export PATH={}:\"$PATH\"\n", quote(rg.parent().unwrap().to_str().unwrap())));
    }
    Payload { name: "exported ripgrep and Git settings", startup, control: Some("git status --short") }
}

/// Payloads go in the interactive files the ticket names. Every other
/// startup file sources them, so `-c`, `-lc` and `-ic` shells all load them.
fn install_startup(home: &Path, startup: &str) {
    std::fs::write(home.join(".zshrc"), startup).unwrap();
    std::fs::write(home.join(".bashrc"), startup).unwrap();
    let source = |file: &str| format!(". {}\n", quote(home.join(file).to_str().unwrap()));
    std::fs::write(home.join(".zshenv"), source(".zshrc")).unwrap();
    for profile in [".bash_profile", ".profile"] {
        std::fs::write(home.join(profile), source(".bashrc")).unwrap();
    }
}

fn in_startup_shell(shell: &Path, home: &Path, cwd: &Path, script: &str, args: &[&std::ffi::OsStr], env: &[(&str, &std::ffi::OsStr)]) -> Output {
    Command::new(shell)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home)
        .env("ZDOTDIR", home)
        .env("BASH_ENV", home.join(".bashrc"))
        .envs(env.iter().copied())
        .current_dir(cwd)
        .arg("-c")
        .arg(script)
        .arg("startup-shell")
        .args(args)
        .output()
        .unwrap()
}

/// What a payload wrote: `marker` itself, or a loader trace `marker.<pid>`
/// of any process but `except`.
fn written(marker: &Path, except: Option<u32>) -> Vec<PathBuf> {
    let name = marker.file_name().unwrap().to_str().unwrap();
    let Ok(entries) = std::fs::read_dir(marker.parent().unwrap()) else { return Vec::new() };
    entries
        .flatten()
        .filter(|entry| {
            let file = entry.file_name();
            let file = file.to_string_lossy();
            file == name
                || file
                    .strip_prefix(name)
                    .and_then(|rest| rest.strip_prefix('.'))
                    .is_some_and(|pid| except.is_none_or(|except| pid != except.to_string()))
        })
        .map(|entry| entry.path())
        .collect()
}

fn clear(marker: &Path) {
    for path in written(marker, None) {
        std::fs::remove_file(path).unwrap();
    }
}

/// zsh, macOS's /bin/bash 3.2 and a bash 5, each with whether it has
/// namerefs. Linux CI's /bin/bash is 5.x, so the bash 5 cases cannot go
/// missing there without failing.
fn shells() -> Vec<(PathBuf, Shell, bool)> {
    let mut shells = vec![(which::which("zsh").expect("zsh: Linux CI installs it"), Shell::Zsh, false)];
    let mut versions = Vec::new();
    for bash in ["/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"] {
        let path = PathBuf::from(bash);
        let Ok(canonical) = std::fs::canonicalize(&path) else { continue };
        if shells.iter().any(|(shell, _, _)| std::fs::canonicalize(shell).ok().as_ref() == Some(&canonical)) {
            continue;
        }
        let version = Command::new(&path)
            .env_clear()
            .args(["-c", "printf '%s.%s' \"${BASH_VERSINFO[0]}\" \"${BASH_VERSINFO[1]}\""])
            .output()
            .unwrap();
        let version = String::from_utf8(version.stdout).unwrap();
        let (major, minor) = version.split_once('.').map(|(a, b)| (a.parse::<u32>().unwrap(), b.parse::<u32>().unwrap())).unwrap();
        shells.push((path, Shell::Bash, (major, minor) >= (4, 3)));
        versions.push(version);
    }
    if cfg!(target_os = "macos") {
        assert!(versions.iter().any(|v| v == "3.2"), "macOS /bin/bash is bash 3.2: {versions:?}");
    }
    if cfg!(target_os = "linux") {
        assert!(
            versions.iter().any(|v| v.split('.').next().unwrap().parse::<u32>().unwrap() >= 5),
            "Linux must exercise bash 5.x: {versions:?}"
        );
    }
    shells
}

const STARTUP_PROBE: &str = "TERMINALX_READ_ONLY_STARTUP_PROBE";
const STARTUP_PROBE_ROOT: &str = "TERMINALX_READ_ONLY_STARTUP_PROBE_ROOT";
/// `NAME=VALUE` the probe puts in its own environment once it runs: what
/// TerminalX inherited, where exporting it first would stop the probe itself
/// from starting (glibc's loader trace flag).
const STARTUP_PROBE_SET: &str = "TERMINALX_READ_ONLY_STARTUP_PROBE_SET";

/// The child half of the test below: TerminalX started by a poisoned shell,
/// inheriting everything that shell exported.
#[test]
fn startup_launched_terminalx_runs_approved_commands_without_a_shell() {
    let Some(marker) = std::env::var_os(STARTUP_PROBE).map(PathBuf::from) else { return };
    let root = PathBuf::from(std::env::var_os(STARTUP_PROBE_ROOT).unwrap());
    let me = std::process::id();
    if let Some(set) = std::env::var(STARTUP_PROBE_SET).ok().filter(|set| !set.is_empty()) {
        let (name, value) = set.split_once('=').unwrap();
        // This child runs this one test on one thread, so nothing else reads
        // the environment while it changes.
        std::env::set_var(name, value);
    }
    // The shell that started this process ran its startup: that is the user
    // starting their own environment. Approving and running commands must
    // run no startup code at all, including any login-shell lookup.
    let _ = std::fs::remove_file(&marker);
    let execution = isolated_execution(&PathBuf::from(std::env::var_os("HOME").unwrap()));
    let approved = |command: &str| {
        approved_in("Bash", &serde_json::json!({"command":command}), root.to_str(), &execution)
            .unwrap_or_else(|| panic!("{command} must be approved"))
    };
    let mut commands = vec![
        ("cat file", 0, "hello\n".to_string()),
        ("grep absent file", 1, String::new()),
        ("pwd; cat file | grep hello", 0, format!("{}\nhello\n", root.display())),
        ("git status --short", 0, "?? file\n".to_string()),
    ];
    if which::which("rg").is_ok() {
        commands.push(("rg hello file", 0, "hello\n".into()));
    }
    for (command, status, expected) in commands {
        let ran = approved(command).run();
        assert_eq!((ran.status, ran.output.as_str()), (status, expected.as_str()), "{command}");
    }
    // Only TerminalX's fixed list reaches a program, whatever this process
    // inherited from startup: no loader, shell-option or function variables.
    let env = Approved::for_test(&root, vec![(Join::Then, vec![vec!["/usr/bin/env"]])], serde_json::json!({})).run();
    assert_eq!(env.status, 0);
    let names: std::collections::BTreeSet<&str> = env.output.lines().filter_map(|line| line.split_once('=').map(|(name, _)| name)).collect();
    let allowed = ["GIT_OPTIONAL_LOCKS", "HOME", "LC_ALL", "PATH", "PWD", "XDG_CONFIG_HOME"];
    assert!(names.iter().all(|name| allowed.contains(name)), "{names:?}");
    // The approved path now names another directory: nothing runs there.
    let plan = approved("cat file");
    let moved = root.with_extension("checked");
    std::fs::rename(&root, &moved).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("file"), "other\n").unwrap();
    let ran = plan.run();
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::rename(&moved, &root).unwrap();
    assert_eq!((ran.status, ran.output.as_str()), (125, ""));
    let leaked = written(&marker, Some(me));
    assert!(leaked.is_empty(), "an approved command ran startup code: {leaked:?}");
    println!("startup probe passed");
}

#[test]
fn startup_payloads_never_reach_auto_approved_commands_in_zsh_and_both_bashes() {
    if std::env::var_os(STARTUP_PROBE).is_some() {
        return;
    }
    let repo = Repository::new();
    std::fs::write(repo.root.join("file"), "hello\n").unwrap();
    let markers = tempfile::tempdir().unwrap();
    let marker = markers.path().join("startup-marker");
    let probe = std::env::current_exe().unwrap();
    for (shell, kind, namerefs) in shells() {
        let mut all = payloads(kind, &marker, namerefs);
        all.push(tool_payload(&repo, &marker));
        for payload in all {
            install_startup(&repo.home, &payload.startup);
            clear(&marker);
            if let Some(control) = payload.control {
                let output = in_startup_shell(&shell, &repo.home, &repo.root, control, &[], &[]);
                assert!(
                    !written(&marker, None).is_empty(),
                    "{shell:?} must load {}: {output:?}",
                    payload.name
                );
                clear(&marker);
            }
            let output = in_startup_shell(
                &shell,
                &repo.home,
                &repo.root,
                "exec \"$1\" --exact harness::read_only::security_tests::startup_launched_terminalx_runs_approved_commands_without_a_shell --nocapture --test-threads=1",
                &[probe.as_os_str()],
                &[(STARTUP_PROBE, marker.as_os_str()), (STARTUP_PROBE_ROOT, repo.root.as_os_str())],
            );
            assert!(
                output.status.success() && String::from_utf8_lossy(&output.stdout).contains("startup probe passed"),
                "{shell:?} with {}:\n{}\n{}",
                payload.name,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

#[test]
fn session_allowances_keep_shell_setup_but_not_a_startup_directory_check() {
    let temp = tempfile::tempdir().unwrap();
    let (approved, other, home) = (temp.path().join("approved"), temp.path().join("other"), temp.path().join("home"));
    let markers = temp.path().join("markers");
    for dir in [&approved, &other, &home, &markers] {
        std::fs::create_dir(dir).unwrap();
    }
    let marker = markers.join("startup-marker");
    // The person approved this command for their own shell: it uses a
    // function their startup defines, and shows that it ran.
    let input = serde_json::json!({"command":"terminalx_setup_probe; : > approved-ran"});
    let key = session_key("Bash", &input, approved.to_str()).unwrap();
    for (shell, kind, namerefs) in shells() {
        for payload in payloads(kind, &marker, namerefs) {
            install_startup(&home, &format!("terminalx_setup_probe() {{ printf 'setup-visible\\n'; }}\n{}", payload.startup));
            let updated = session_input("Bash", &input, &key).unwrap();
            let script = updated["command"].as_str().unwrap();
            clear(&marker);
            let wrong = in_startup_shell(&shell, &home, &other, script, &[], &[]);
            assert_eq!(wrong.status.code(), Some(125), "{shell:?} with {}: {wrong:?}", payload.name);
            assert!(!other.join("approved-ran").exists(), "{shell:?} with {}", payload.name);
            if payload.name.starts_with("a function") {
                // No startup function stands in for the check, so none ran.
                assert!(written(&marker, None).is_empty(), "{shell:?} with {}", payload.name);
            }
            let right = in_startup_shell(&shell, &home, &approved, script, &[], &[]);
            assert!(right.status.success(), "{shell:?} with {}: {right:?}", payload.name);
            assert!(String::from_utf8_lossy(&right.stdout).contains("setup-visible"), "{shell:?} with {}: {right:?}", payload.name);
            std::fs::remove_file(approved.join("approved-ran")).unwrap();
        }
    }
}

/// Repository fixtures' Git environment: a private HOME and no system config.
fn isolated_execution(home: &Path) -> Execution {
    let mut execution = Execution::owner();
    execution
        .env
        .retain(|(key, _)| !matches!(*key, "HOME" | "XDG_CONFIG_HOME"));
    execution.env.extend([
        ("HOME", home.to_str().unwrap().into()),
        ("XDG_CONFIG_HOME", home.join("config").to_str().unwrap().into()),
        ("GIT_CONFIG_NOSYSTEM", "1".into()),
    ]);
    execution
}

#[test]
fn approved_commands_keep_pipes_conditionals_statuses_and_literal_arguments() {
    let repo = Repository::new();
    std::fs::write(repo.root.join("a'b;file"), "hello\n").unwrap();
    for (command, status, expected) in [
        ("cat \"a'b;file\" | grep -n hello", 0, "1:hello\n"),
        ("grep absent \"a'b;file\" || cat \"a'b;file\"", 0, "hello\n"),
        ("grep absent \"a'b;file\" && cat \"a'b;file\"; cat \"a'b;file\"", 0, "hello\n"),
        ("grep absent \"a'b;file\" && cat \"a'b;file\" || grep -c hello \"a'b;file\"", 0, "1\n"),
        ("cat \"a'b;file\" | grep absent", 1, ""),
        ("grep absent \"a'b;file\"", 1, ""),
        ("cat missing-file", 1, "missing-file"),
        ("rg '$(literal)' \"a'b;file\" || pwd -P", 0, "/"),
    ] {
        if command.starts_with("rg") && which::which("rg").is_err() {
            continue;
        }
        let ran = repo.approved(command).unwrap().run();
        assert_eq!(ran.status, status, "{command}: {}", ran.output);
        assert!(
            if expected.ends_with('\n') || expected.is_empty() { ran.output == expected } else { ran.output.contains(expected) },
            "{command}: {:?}",
            ran.output
        );
    }
}

#[test]
fn a_checked_repository_cannot_authorize_git_execution_in_another_workdir() {
    let checked = Repository::new();
    let execution = Repository::new();
    std::fs::write(execution.root.join("tracked"), "before\n").unwrap();
    execution.run(&execution.root, &["add", "tracked"]);
    execution.run(
        &execution.root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "tracked fixture",
        ],
    );
    std::fs::write(execution.root.join("tracked"), "after\n").unwrap();
    let marker = execution.home.join("diff-marker");
    let helper = execution.helper(
        "external-diff",
        &format!(": > {}", quote(marker.to_str().unwrap())),
    );
    execution.run(
        &execution.root,
        &["config", "diff.external", helper.to_str().unwrap()],
    );
    let plan = checked.approved("git diff").unwrap();
    // Swap the checked repository's path for the one with the helper.
    let moved = checked.root.with_extension("checked");
    std::fs::rename(&checked.root, &moved).unwrap();
    std::fs::rename(&execution.root, &checked.root).unwrap();
    let ran = plan.run();
    std::fs::rename(&checked.root, &execution.root).unwrap();
    std::fs::rename(&moved, &checked.root).unwrap();
    assert_eq!(
        ran.status, 125,
        "the checked workdir must be bound to execution: {}",
        ran.output
    );
    assert!(!marker.exists());
    assert_eq!(plan.run().status, 0, "the checked repository itself still runs");
    assert!(
        execution.approved("git diff").is_none(),
        "the actual repository's helper config must ask"
    );
    execution.run(&execution.root, &["diff"]);
    assert!(
        marker.exists(),
        "fixture must reproduce an unchecked external diff helper"
    );
}

#[test]
fn approved_programs_get_no_stdin_a_deadline_and_bounded_output() {
    let dir = tempfile::tempdir().unwrap();
    let run = |argv: Vec<&str>, input| Approved::for_test(dir.path(), vec![(Join::Then, vec![argv])], input).run();
    let ran = run(vec!["/bin/cat"], serde_json::json!({}));
    assert_eq!((ran.status, ran.output.as_str()), (0, ""), "stdin is /dev/null");
    let ran = run(vec!["/nonexistent/terminalx-program"], serde_json::json!({}));
    assert_eq!(ran.status, 127);
    assert!(ran.output.contains("terminalx: /nonexistent/terminalx-program"), "{}", ran.output);
    // A timeout stops the program's whole process group, including what it
    // left running in the background holding the output pipe.
    let started = std::time::Instant::now();
    let ran = run(vec!["/bin/sh", "-c", "/bin/sleep 30 & echo $!; wait"], serde_json::json!({"timeout": 1000}));
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert_eq!(ran.status, 124);
    assert!(ran.report().contains("TerminalX stopped it after 1 s."));
    let background: i32 = ran.output.trim().parse().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(100));
    // SAFETY: signal 0 only checks whether the process still exists.
    assert_eq!(unsafe { libc::kill(background, 0) }, -1, "the background sleep must be stopped");
    // Nobody left to read the result: the programs stop and nothing is said.
    let stop = std::sync::atomic::AtomicBool::new(false);
    let plan = Approved::for_test(dir.path(), vec![(Join::Then, vec![vec!["/bin/sh", "-c", "echo $$; exec /bin/sleep 30"]])], serde_json::json!({}));
    let started = std::time::Instant::now();
    let ran = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(300));
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        plan.run_while(&|| !stop.load(std::sync::atomic::Ordering::SeqCst))
    });
    assert!(ran.is_none());
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    std::fs::write(dir.path().join("big"), "x".repeat(100_000)).unwrap();
    let ran = run(vec!["/bin/cat", "big"], serde_json::json!({"max_output_tokens": 256}));
    assert_eq!(ran.status, 0);
    assert!(ran.output.len() < 1200, "{}", ran.output.len());
    assert!(ran.report().contains("The output was 100000 bytes; 98976 bytes in the middle are left out."), "{}", ran.report());
}

#[test]
fn session_rewrites_preserve_shell_syntax_and_reject_changed_commands() {
    let dir = tempfile::tempdir().unwrap();
    // Arbitrary explicitly approved syntax must remain quoted inside eval,
    // rather than being able to close or comment out the directory guard.
    let input = serde_json::json!({"command":"cat > \"a'b\" <<'END'\nhello; 'quoted'\nEND\n# trailing comment", "timeout":1000});
    let key = session_key("Bash", &input, dir.path().to_str()).unwrap();
    let updated = session_input("Bash", &input, &key).unwrap();
    let output = Command::new("/bin/sh")
        .current_dir(dir.path())
        .args(["-c", updated["command"].as_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a'b")).unwrap(),
        "hello; 'quoted'\n"
    );
    assert_eq!(updated["timeout"], 1000);
    assert!(session_input("Bash", &serde_json::json!({"command":"rm file"}), &key).is_none());
    assert!(session_input("Bash", &input, "legacy-key").is_none());
    let elsewhere = tempfile::tempdir().unwrap();
    let output = Command::new("/bin/sh")
        .current_dir(elsewhere.path())
        .args(["-c", updated["command"].as_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(125));
    assert!(String::from_utf8_lossy(&output.stderr).contains("outside its approved directory"));
    assert!(!elsewhere.path().join("a'b").exists());
}

#[test]
fn finder_launch_uses_trusted_developer_install_directories() {
    const CHILD: &str = "TERMINALX_READ_ONLY_FINDER_TEST";
    if let Some(home) = std::env::var_os(CHILD).map(PathBuf::from) {
        assert_eq!(
            std::env::var("PATH").unwrap(),
            "/usr/bin:/bin:/usr/sbin:/sbin"
        );
        let tool = home.join(".local/bin/rg");
        assert_ne!(
            which::which("rg").ok().as_ref(),
            Some(&tool),
            "the inherited Finder PATH must not find the test install"
        );
        let cwd = std::env::current_dir().unwrap();
        let ran = approved(
            "Bash",
            &serde_json::json!({"command":"pwd; rg --files"}),
            cwd.to_str(),
        )
        .unwrap()
        .run();
        assert_eq!(ran.status, 0, "{}", ran.output);
        assert!(
            ran.output.contains("trusted-rg"),
            "use TerminalX's trusted developer tool resolution: {}",
            ran.output
        );
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let work = temp.path().join("work");
    let bin = home.join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir(&work).unwrap();
    let tool = bin.join("rg");
    std::fs::write(&tool, "#!/bin/sh\nprintf 'trusted-rg\\n'\n").unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o700)).unwrap();
    // An isolated child keeps global PATH, HOME and binpath caches out of
    // the rest of the test process, just as a fresh Finder launch would.
    let output = Command::new(std::env::current_exe().unwrap()).env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").env("SHELL", "/bin/sh")
        .env("HOME", &home).env("TERMINALX_HOME", temp.path().join("data")).env(CHILD, &home)
        .current_dir(&work)
        .args(["--exact", "harness::read_only::security_tests::finder_launch_uses_trusted_developer_install_directories", "--nocapture"])
        .output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

// PRO-267's (#893) startup attacks on the in-shell guard, ported to the
// PRO-330 path. Each keeps its startup and its control, which proves the
// payload is live in that shell. The step "run the guarded replacement in
// the startup shell" no longer exists: the provider is given nothing to run.
// What is left to check is TerminalX itself started by that shell: approved
// commands still give `cat file` 0 and `hello`, `grep absent file` 1, and
// 125 with no output once the approved directory is swapped, and no payload
// runs, whatever the process's own working directory.

fn startup_shell_command(repo: &Repository, shell: &Path, command: &str) -> Output {
    startup_shell_command_in(repo, shell, command, &repo.root)
}

fn startup_shell_command_in(repo: &Repository, shell: &Path, command: &str, cwd: &Path) -> Output {
    Command::new(shell)
        .env_clear()
        .envs(repo.execution.env.iter().map(|(key, value)| (*key, value)))
        .env("ZDOTDIR", &repo.home)
        .env("BASH_ENV", repo.home.join(".zshenv"))
        .current_dir(cwd)
        .args(["-c", command])
        .output()
        .unwrap()
}

/// TerminalX's probe started by the startup shell above from `cwd`, after
/// `prefix` ran in that shell, with `set` in the probe's own environment.
fn probe_from_startup(repo: &Repository, shell: &Path, cwd: &Path, prefix: &str, marker: &Path, set: Option<&str>) -> Output {
    let probe = std::env::current_exe().unwrap();
    let script = format!(
        "{prefix}\nexec {} --exact harness::read_only::security_tests::startup_launched_terminalx_runs_approved_commands_without_a_shell --nocapture --test-threads=1",
        quote(probe.to_str().unwrap())
    );
    Command::new(shell)
        .env_clear()
        .envs(repo.execution.env.iter().map(|(key, value)| (*key, value)))
        .env("ZDOTDIR", &repo.home)
        .env("BASH_ENV", repo.home.join(".zshenv"))
        .env(STARTUP_PROBE, marker)
        .env(STARTUP_PROBE_ROOT, &repo.root)
        .env(STARTUP_PROBE_SET, set.unwrap_or(""))
        .current_dir(cwd)
        .args(["-c", &script])
        .output()
        .unwrap()
}

fn assert_probe(output: &Output, context: &str) {
    assert!(
        output.status.success() && String::from_utf8_lossy(&output.stdout).contains("startup probe passed"),
        "{context}:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn startup_global_aliases_cannot_replace_descriptor_operands() {
    if std::env::var_os(STARTUP_PROBE).is_some() {
        return;
    }
    let repo = Repository::new();
    let shell = Path::new("/bin/zsh");
    std::fs::write(repo.root.join("file"), "hello\n").unwrap();
    let marker = repo.home.join("descriptor-alias-write");
    for operand in ["0", "8", "-"] {
        std::fs::write(
            repo.home.join(".zshenv"),
            format!(
                "alias -g -- {}\n",
                quote(&format!(
                    "{operand}={operand}; printf invoked > {}; :",
                    quote(marker.to_str().unwrap())
                ))
            ),
        )
        .unwrap();
        // Redirection operands are words too: a global alias can insert a
        // command and replace a failure status before the guard is evaluated.
        startup_shell_command(&repo, shell, "'/usr/bin/true' 8<&0 0<&8 8<&-");
        assert!(marker.exists(), "the {operand} alias must execute in the control");
        std::fs::remove_file(&marker).unwrap();
        for cwd in [&repo.root, &repo.home] {
            let output = probe_from_startup(&repo, shell, cwd, "", &marker, None);
            assert_probe(&output, &format!("descriptor alias {operand} from {cwd:?}"));
            assert!(!marker.exists(), "descriptor alias {operand} executed");
        }
    }
}

#[test]
fn startup_loader_namerefs_cannot_execute_before_the_directory_guard() {
    if std::env::var_os(STARTUP_PROBE).is_some() {
        return;
    }
    let repo = Repository::new();
    let shell = Path::new("/bin/bash");
    let supports_nameref = Command::new(shell)
        .env_clear()
        .args(["-c", "declare -n ref=target"])
        .output()
        .unwrap()
        .status
        .success();
    // macOS's system bash 3.2 has no namerefs. Linux CI must exercise this
    // Bash 5.x attack rather than silently treating an invalid fixture as safe.
    assert!(supports_nameref || !cfg!(target_os = "linux"));
    if !supports_nameref {
        return;
    }
    std::fs::write(repo.root.join("file"), "hello\n").unwrap();
    let marker = repo.home.join("nameref-write");
    for target in ["declare -a target", "declare -a target=([0]='present')"] {
        std::fs::write(
            repo.home.join(".zshenv"),
            format!(
                "{target}\ndeclare -n LD_TRACE_LOADED_OBJECTS={}\n",
                quote(&format!(
                    "target[$(touch {}; printf 0)]",
                    quote(marker.to_str().unwrap())
                ))
            ),
        )
        .unwrap();
        // Even a presence-only expansion of an unexported reference to an
        // unset element evaluates its subscript. Prove the fixture is active.
        let control = startup_shell_command(
            &repo,
            shell,
            "'/usr/bin/printf' '%s' \"${LD_TRACE_LOADED_OBJECTS+present}\"",
        );
        assert!(control.status.success(), "{control:?}");
        assert!(marker.exists(), "the nameref payload must execute in the control");
        std::fs::remove_file(&marker).unwrap();
        for cwd in [&repo.root, &repo.home] {
            let output = probe_from_startup(&repo, shell, cwd, "", &marker, None);
            assert_probe(&output, &format!("{target} from {cwd:?}"));
            assert!(!marker.exists(), "nameref executed");
        }
    }
}

#[test]
fn startup_functions_cannot_run_during_environment_cleanup() {
    if std::env::var_os(STARTUP_PROBE).is_some() {
        return;
    }
    let repo = Repository::new();
    std::fs::write(repo.root.join("file"), "hello\n").unwrap();
    let marker = repo.home.join("unapproved-write");
    // Poison likely cleanup builtins as well as unset. Quoting a command name
    // suppresses aliases but still resolves these functions in bash and zsh.
    let mut startup =
        String::from("if [ -n \"$BASH_VERSION\" ]; then shopt -s expand_aliases; fi\n");
    for name in [
        "unset", "builtin", "command", "false", "exit", "true", ":", "trap",
    ] {
        startup.push_str(&format!(
            "{name}() {{ printf invoked > {}; }}\n",
            quote(marker.to_str().unwrap())
        ));
    }
    startup.push_str(&format!(
        "alias case={}\nalias unset={}\n",
        quote(&format!(
            "printf invoked > {}; case",
            quote(marker.to_str().unwrap())
        )),
        quote(&format!(
            "printf invoked > {}",
            quote(marker.to_str().unwrap())
        ))
    ));
    // Neither a command-less redirection nor an empty expansion is a safe
    // status helper: zsh can dispatch NULLCMD or a global alias respectively.
    startup.push_str("NULLCMD=unset\nREADNULLCMD=unset\nif [ -n \"$ZSH_VERSION\" ]; then alias -g '${?+}=unset'; fi\nalias '!=unset'\n");
    for shell in ["/bin/bash", "/bin/zsh"] {
        let shell = Path::new(shell);
        let mut shell_startup = startup.clone();
        if shell == Path::new("/bin/bash") {
            let supports_nameref = Command::new(shell)
                .env_clear()
                .args(["-c", "declare -n ref=target"])
                .output()
                .unwrap()
                .status
                .success();
            // Linux CI's bash supports namerefs; macOS's system bash 3.2 does
            // not. Keep the Linux regression mandatory instead of skipping it.
            assert!(supports_nameref || !cfg!(target_os = "linux"));
            if supports_nameref {
                shell_startup.push_str(&format!(
                    "declare -a locale_target\ndeclare -n LC_ALL={}\n",
                    quote(&format!(
                        "locale_target[$(printf invoked > {}; printf 0)]",
                        quote(marker.to_str().unwrap())
                    ))
                ));
            }
        }
        std::fs::write(repo.home.join(".zshenv"), shell_startup).unwrap();
        // Prove that this shell actually loaded the malicious startup function.
        let control = startup_shell_command(&repo, shell, "'unset' LD_TRACE_LOADED_OBJECTS");
        assert!(control.status.success(), "{control:?}");
        assert!(marker.exists());
        std::fs::remove_file(&marker).unwrap();
        for cwd in [&repo.root, &repo.home] {
            // Also with glibc's loader trace flag in TerminalX's environment.
            for set in [None, Some("LD_TRACE_LOADED_OBJECTS=")] {
                let output = probe_from_startup(&repo, shell, cwd, "", &marker, set);
                assert_probe(&output, &format!("{shell:?} from {cwd:?} with {set:?}"));
                assert!(!marker.exists(), "a startup function ran: {shell:?}");
            }
        }
    }
}

#[test]
fn startup_error_traps_cannot_turn_rejection_into_success() {
    if std::env::var_os(STARTUP_PROBE).is_some() {
        return;
    }
    let repo = Repository::new();
    std::fs::write(repo.root.join("file"), "hello\n").unwrap();
    let marker = repo.home.join("error-trap-write");
    let handler = format!(
        "printf invoked > {}; exit 0",
        quote(marker.to_str().unwrap())
    );
    // zsh function traps survive subshell entry, unlike its list-style traps.
    // Test both spellings and bash's ERR inheritance, including strict modes.
    for (shell, trap) in [
        ("/bin/zsh", format!("TRAPZERR() {{ {handler}; }}")),
        ("/bin/zsh", format!("TRAPERR() {{ {handler}; }}")),
        ("/bin/zsh", format!("trap {} ZERR", quote(&handler))),
        ("/bin/bash", format!("set -E; trap {} ERR", quote(&handler))),
    ] {
        for strict in ["", "set -eu"] {
            // Exporting glibc's trace flag from startup would stop TerminalX
            // itself from starting, so it goes in the probe's environment.
            for (loader, set) in [
                ("", None),
                ("export LD_TRACE_LOADED_OBJECTS=''", Some("LD_TRACE_LOADED_OBJECTS=")),
                ("export LD_TRACE_LOADED_OBJECTS=1", Some("LD_TRACE_LOADED_OBJECTS=1")),
                ("readonly LD_TRACE_LOADED_OBJECTS=1; export LD_TRACE_LOADED_OBJECTS", Some("LD_TRACE_LOADED_OBJECTS=1")),
            ] {
                std::fs::write(repo.home.join(".zshenv"), format!("{loader}\n{trap}\n{strict}\n")).unwrap();
                let shell = Path::new(shell);
                // Prove the fixture can write and forge success on an unguarded
                // redirection error, before any executable loads.
                let control = startup_shell_command(
                    &repo,
                    shell,
                    "'/usr/bin/env' '-i' 9<'/dev/null/refused'",
                );
                assert!(control.status.success(), "{control:?}");
                assert!(marker.exists(), "the error hook must be active: {shell:?}");
                std::fs::remove_file(&marker).unwrap();
                std::fs::write(repo.home.join(".zshenv"), format!("{trap}\n{strict}\n")).unwrap();
                for cwd in [&repo.root, &repo.home] {
                    let output = probe_from_startup(&repo, shell, cwd, "", &marker, set);
                    assert_probe(&output, &format!("{shell:?}, {strict:?}, {loader:?} from {cwd:?}"));
                    assert!(!marker.exists(), "error hook ran: {shell:?}, {strict:?}, {loader:?}");
                }
            }
        }
    }
}

#[test]
fn loader_trace_cannot_replace_sanitized_execution_or_its_directory_guard() {
    if std::env::var_os(STARTUP_PROBE).is_some() {
        return;
    }
    let repo = Repository::new();
    std::fs::write(repo.root.join("file"), "hello\n").unwrap();
    let marker = repo.home.join("loader-trace-marker");
    std::fs::write(repo.home.join(".zshenv"), "").unwrap();
    for shell in ["/bin/sh", "/bin/bash", "/bin/zsh"] {
        let shell = Path::new(shell);
        // Unexported, the flag stays in the shell. Exported, it is in what
        // TerminalX inherits: put there once the probe runs, since glibc
        // would otherwise trace the probe's own start and stop it, as it
        // would TerminalX's. Approved programs must run normally either way.
        for (prefix, set) in [
            ("LD_TRACE_LOADED_OBJECTS=''", None),
            ("", Some("LD_TRACE_LOADED_OBJECTS=")),
            ("", Some("LD_TRACE_LOADED_OBJECTS=1")),
        ] {
            for cwd in [&repo.root, &repo.home] {
                let output = probe_from_startup(&repo, shell, cwd, prefix, &marker, set);
                assert_probe(&output, &format!("{shell:?} {prefix:?} {set:?} from {cwd:?}"));
            }
        }
    }
}
