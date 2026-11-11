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
        let mut execution = Execution::owner();
        execution
            .env
            .retain(|(key, _)| !matches!(*key, "HOME" | "XDG_CONFIG_HOME"));
        execution.env.extend([
            ("HOME", home.to_str().unwrap().into()),
            (
                "XDG_CONFIG_HOME",
                home.join("config").to_str().unwrap().into(),
            ),
            ("GIT_CONFIG_NOSYSTEM", "1".into()),
        ]);
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

    fn approved_at(&self, command: &str, cwd: &Path) -> Option<Value> {
        approved_input_in(
            "Bash",
            &serde_json::json!({"command":command}),
            cwd.to_str(),
            &self.execution,
        )
    }

    fn approved(&self, command: &str) -> Option<Value> {
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

#[test]
fn shell_startup_cannot_supply_ripgrep_preprocessors_or_git_environment() {
    let repo = Repository::new();
    let shell = which::which("zsh")
        .or_else(|_| which::which("bash"))
        .expect("a shell with startup files");
    let Ok(rg) = which::which("rg") else {
        eprintln!("Skipping ripgrep executable reproduction: rg is not installed");
        return;
    };
    let marker = repo.home.join("pre-marker");
    let trace = repo.home.join("git-trace");
    let helper = repo.helper(
        "preprocessor",
        &format!(": > {}\ncat \"$1\"", quote(marker.to_str().unwrap())),
    );
    let config = repo.home.join("rg-config");
    std::fs::write(&config, format!("--pre\n{}\n", helper.display())).unwrap();
    std::fs::write(repo.root.join("file"), "hello\n").unwrap();
    std::fs::write(repo.home.join(".zshenv"), format!(
        "export PATH={}:\"$PATH\"\nexport RIPGREP_CONFIG_PATH={}\nexport GIT_TRACE={}\nexport GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0=core.fsmonitor\nexport GIT_CONFIG_VALUE_0={}\n",
        quote(rg.parent().unwrap().to_str().unwrap()), quote(config.to_str().unwrap()), quote(trace.to_str().unwrap()), quote(helper.to_str().unwrap())
    )).unwrap();
    if cfg!(target_os = "linux") {
        let mut profile = std::fs::OpenOptions::new()
            .append(true)
            .open(repo.home.join(".zshenv"))
            .unwrap();
        writeln!(
            profile,
            "export LD_DEBUG=libs\nexport LD_DEBUG_OUTPUT={}",
            quote(repo.home.join("loader-trace").to_str().unwrap())
        )
        .unwrap();
    }
    let run = |command: &str| startup_shell_command(&repo, &shell, command);
    let unsafe_output = run("rg hello file");
    assert!(unsafe_output.status.success());
    assert!(
        marker.exists(),
        "fixture must reproduce .zshenv's configured preprocessor"
    );
    std::fs::remove_file(&marker).unwrap();
    for entry in std::fs::read_dir(&repo.home).unwrap().flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("loader-trace")
        {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
    for command in ["rg hello file", "git status --short", "pwd; rg --files"] {
        let updated = repo.approved(command).expect(command);
        let output = run(updated["command"].as_str().unwrap());
        assert!(
            output.status.success(),
            "{command}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !marker.exists(),
            "shell startup must not enable a helper for {command}"
        );
        assert!(
            !trace.exists(),
            "shell startup must not enable Git trace writes"
        );
        assert!(
            !std::fs::read_dir(&repo.home)
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("loader-trace")),
            "even the environment reset must not inherit loader trace writes"
        );
    }
}

fn startup_shell_command(repo: &Repository, shell: &Path, command: &str) -> Output {
    Command::new(shell)
        .env_clear()
        .envs(repo.execution.env.iter().map(|(key, value)| (*key, value)))
        .env("ZDOTDIR", &repo.home)
        .env("BASH_ENV", repo.home.join(".zshenv"))
        .current_dir(&repo.root)
        .args(["-c", command])
        .output()
        .unwrap()
}

#[test]
fn sanitized_execution_preserves_pipes_conditionals_and_literal_arguments() {
    let repo = Repository::new();
    std::fs::write(repo.root.join("a'b;file"), "hello\n").unwrap();
    for (command, expected) in [
        ("cat \"a'b;file\" | grep -n hello", "1:hello\n"),
        ("grep absent \"a'b;file\" || cat \"a'b;file\"", "hello\n"),
        (
            "grep absent \"a'b;file\" && cat \"a'b;file\"; cat \"a'b;file\"",
            "hello\n",
        ),
    ] {
        let updated = repo.approved(command).unwrap();
        let output = Command::new("/bin/sh")
            .current_dir(&repo.root)
            .args(["-c", updated["command"].as_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
    }
}

#[test]
fn loader_trace_cannot_replace_sanitized_execution_or_its_directory_guard() {
    let repo = Repository::new();
    std::fs::write(repo.root.join("file"), "hello\n").unwrap();
    let updated = repo.approved("cat file").unwrap();
    let command = updated["command"].as_str().unwrap();
    for shell in ["/bin/sh", "/bin/bash", "/bin/zsh"] {
        // Set the flag inside the already-running shell: putting it in Command's
        // environment would trace the outer shell before our wrapper can run.
        for value in ["", "1"] {
            let script = format!("export LD_TRACE_LOADED_OBJECTS={}; {command}", quote(value));
            let output = Command::new(shell)
                .current_dir(&repo.root)
                .args(["-c", &script])
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            assert_eq!(output.stdout, b"hello\n");
            let outside = Command::new(shell)
                .current_dir(&repo.home)
                .args(["-c", &script])
                .output()
                .unwrap();
            assert_eq!(outside.status.code(), Some(125), "{outside:?}");
            assert!(outside.stdout.is_empty());
        }
        let output = Command::new(shell)
            .current_dir(&repo.root)
            .args([
                "-c",
                &format!(
                    "readonly LD_TRACE_LOADED_OBJECTS=1; export LD_TRACE_LOADED_OBJECTS; {command}"
                ),
            ])
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "an unremovable loader flag must fail closed"
        );
        assert!(
            output.stdout.is_empty(),
            "no loader or tool should run: {output:?}"
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
    let updated = checked.approved("git diff").unwrap();
    let output = Command::new("/bin/sh")
        .current_dir(&execution.root)
        .args(["-c", updated["command"].as_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(125),
        "the checked workdir must be bound to execution"
    );
    assert!(!marker.exists());
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
        let updated = approved_input(
            "Bash",
            &serde_json::json!({"command":"pwd; rg --files"}),
            cwd.to_str(),
        )
        .unwrap();
        let command = updated["command"].as_str().unwrap();
        assert!(
            command.contains(tool.to_str().unwrap()),
            "use TerminalX's trusted developer tool resolution"
        );
        let output = Command::new("/bin/sh")
            .args(["-c", command])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains("trusted-rg"));
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
