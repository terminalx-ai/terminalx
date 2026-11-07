//! Real public identity/issue calls against observed gh/ssh executables. Each
//! policy scenario runs in an isolated process, including the managed override.
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::{data_privacy, github_identity, issue_ops, issues, store};

const OPERATIONS: &[&str] = &["ssh", "https", "list", "legacy-read", "legacy-write", "details", "write", "repositories"];

#[test]
fn privacy_covers_identity_and_issue_entry_points() {
    for managed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github_process::tests::privacy_entry_points_child", "--nocapture"])
            .env("TERMINALX_TEST_GITHUB_ENTRIES", if managed { "managed" } else { "personal" })
            .env("TERMINALX_HOME", root.path()).output().unwrap();
        assert!(output.status.success(), "policy={managed}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

fn policy(enabled: bool, managed: bool) {
    if enabled && managed { std::env::set_var("TERMINALX_TEST_MANAGED_PRIVACY", "1"); }
    else { std::env::remove_var("TERMINALX_TEST_MANAGED_PRIVACY"); }
    store::write_json(&store::root().unwrap().join("data-privacy.json"), &serde_json::json!({"enabled":enabled && !managed})).unwrap();
    let status = data_privacy::refresh();
    assert_eq!(status.enabled, enabled);
    assert_eq!(status.managed, enabled && managed);
}

fn invoke(operation: &str, cwd: &Path) -> bool {
    match operation {
        "ssh" | "https" => {
            // Real local git config remains available on both policy settings.
            let answer = github_identity::identity(cwd, true);
            assert_eq!(answer.email.as_deref(), Some("local@example.test"));
            assert_eq!(answer.repo.as_deref(), Some("privacy/fixture"));
            assert_eq!(answer.remote_host.as_deref(), Some("github"));
            answer.login.as_deref() == Some("privacy-reader")
        }
        "list" => issues::github_list(cwd, &issues::IssueFilter::default()).is_ok(),
        "legacy-read" => issues::github_details(cwd, "7").is_ok(),
        "legacy-write" => issues::github_comment(cwd, "privacy/fixture", 7, "hello").is_ok(),
        "details" => issue_ops::github::details(cwd, "privacy/fixture", "7").is_ok(),
        // Exceed the pipe capacity: cancellation must work even when gh never
        // reads a body, not only while waiting for a short read-only request.
        "write" => issue_ops::github::set_title(cwd, "privacy/fixture", "7", &"x".repeat(2 * 1024 * 1024)).is_ok(),
        "repositories" => matches!(crate::project_start::github_repositories(), crate::project_start::GithubRepositories::Ready { .. }),
        _ => panic!("unknown operation {operation}"),
    }
}

fn launches(root: &Path) -> usize {
    std::fs::read_to_string(root.join("launches")).unwrap_or_default().lines().count()
}

fn held(root: &Path) -> Vec<i32> {
    std::fs::read_dir(root).unwrap().flatten().filter_map(|entry| {
        entry.file_name().to_str()?.strip_prefix("held-")?.parse().ok()
    }).collect()
}

fn fixture(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = r#"#!/bin/sh
printf '%s %s\n' "${0##*/}" "$*" >> "$TERMINALX_HOME/launches"
# auth token reads local gh credentials; the network boundary is api below.
case "$*" in
 'auth token '*) printf 'local-fixture-token\n'; exit 0 ;;
esac
hold=''
if [ -f "$TERMINALX_HOME/hold" ]; then read -r hold < "$TERMINALX_HOME/hold"; fi
case "$hold:$*" in
 all:*|write:*' -X PATCH '*)
   : > "$TERMINALX_HOME/held-$$"
   exec /bin/sleep 30 ;;
esac
case "${0##*/}" in
 ssh) printf "Hi privacy-reader! You've successfully authenticated.\n" >&2; exit 1 ;;
esac
case "$*" in
 'auth status '*) printf 'Logged in to github.com account privacy-reader\n  Active account: true\n'; exit 0 ;;
esac
for arg do
 if [ "$arg" = '--input' ]; then /bin/cat > /dev/null; fi
done
case "$*" in
 *' repos/privacy/fixture '*|*' repos/privacy/fixture') printf '{"full_name":"privacy/fixture","permissions":{"push":true}}\n' ;;
 *' user/repos?'*) printf '{"nameWithOwner":"privacy/fixture","isPrivate":true}\n' ;;
 'issue list '*) printf '[]\n' ;;
 *'repos/privacy/fixture/issues -f '*) printf '[]\n' ;;
 'issue comment '*) printf 'https://github.com/privacy/fixture/issues/7#issuecomment-1\n' ;;
 *) printf '{"number":7,"title":"Privacy fixture","state":"open","html_url":"https://github.com/privacy/fixture/issues/7"}\n' ;;
esac
"#;
    for tool in ["ssh", "gh"] {
        let path = bin.join(tool);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // Resolve only these observed substitutes, before binpath caches anything.
    assert!(crate::binpath::set_priority_dir(&bin));
    std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin.display()));
    let mut paths = Vec::new();
    for (name, remote) in [("ssh-project", "git@github.com:privacy/fixture.git"), ("https-project", "https://github.com/privacy/fixture.git")] {
        let cwd = root.join(name);
        std::fs::create_dir_all(&cwd).unwrap();
        for args in [vec!["init", "-q"], vec!["config", "user.email", "local@example.test"], vec!["remote", "add", "origin", remote]] {
            assert!(Command::new("/usr/bin/git").current_dir(&cwd).args(args).status().unwrap().success());
        }
        paths.push(cwd);
    }
    (paths.remove(0), paths.remove(0))
}

#[test]
fn privacy_entry_points_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_GITHUB_ENTRIES") else { return };
    let managed = kind == "managed";
    let root = store::root().unwrap();
    let (ssh, https) = fixture(&root);
    policy(true, managed);
    // Agent-owned executables are not globally intercepted: the same observed
    // gh remains runnable outside the app's request boundary while privacy is on.
    let direct = Command::new(root.join("bin/gh")).args(["auth", "status", "--hostname", "github.com"]).output().unwrap();
    assert!(direct.status.success());
    assert!(String::from_utf8_lossy(&direct.stdout).contains("privacy-reader"));
    let templates = ssh.join(".github/ISSUE_TEMPLATE");
    std::fs::create_dir_all(&templates).unwrap();
    std::fs::write(templates.join("bug.md"), "---\nname: Bug\nabout: Describe a problem\n---\nLocal template").unwrap();
    assert_eq!(issue_ops::templates::load(&ssh).unwrap().len(), 1);
    for operation in OPERATIONS {
        println!("privacy identity/issues: {kind}/{operation}");
        let cwd = if *operation == "https" { &https } else { &ssh };
        policy(true, managed);
        let before = launches(&root);
        assert!(!invoke(operation, cwd), "{operation} allowed while enabled");
        assert_eq!(launches(&root), before, "{operation} spawned while enabled");
        assert_eq!(issues::github_repo(cwd).as_deref(), Some("privacy/fixture"));

        policy(false, managed);
        // This is the queue wrapper used by the UI command and RPC dispatchers.
        // It captures before dispatch and invokes the real operation afterwards.
        let stale = super::queued(|| invoke(operation, cwd));
        policy(true, managed);
        policy(false, managed);
        assert!(!stale(), "{operation} revived from a stale queue");
        assert_eq!(launches(&root), before, "stale {operation} spawned after off/on");

        std::fs::write(root.join("hold"), if *operation == "write" { "write\n" } else { "all\n" }).unwrap();
        let worker = std::thread::spawn({
            let operation = operation.to_string();
            let cwd = cwd.to_path_buf();
            super::queued(move || invoke(&operation, &cwd))
        });
        let until = Instant::now() + Duration::from_secs(10);
        while held(&root).is_empty() {
            assert!(!worker.is_finished(), "{operation} returned before its physical request");
            assert!(Instant::now() < until, "{operation} did not launch observed process");
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        policy(true, managed);
        assert!(started.elapsed() < Duration::from_secs(5), "{operation} failed to drain on activation");
        for pid in held(&root) {
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{operation} acknowledged before process exit");
        }
        assert!(!worker.join().unwrap(), "{operation} accepted revoked output");
        let after = launches(&root);
        std::fs::remove_file(root.join("hold")).unwrap();
        for pid in held(&root) { std::fs::remove_file(root.join(format!("held-{pid}"))).unwrap(); }
        policy(false, managed);
        assert_eq!(launches(&root), after, "restoration must not replay work");
        if matches!(*operation, "ssh" | "https") {
            assert_eq!(github_identity::identity(cwd, false).login.as_deref(), Some("privacy-reader"), "disabled lookups must not cache an absent login");
        }
        assert!(invoke(operation, cwd), "{operation} did not restore without sign-in");
        assert!(launches(&root) > after, "{operation} restoration didn't exercise a real process");
    }
    #[cfg(feature = "desktop")]
    queued_commands(&root, &ssh, managed);
    let observed = std::fs::read_to_string(root.join("launches")).unwrap();
    assert!(observed.contains("ControlMaster=no -o ControlPath=none -o ControlPersist=no"));
}

/// Saturate the actual Tauri blocking pool, poll each IPC command until queued,
/// flip the policy, then let it run. No sleeps decide whether capture happened.
#[cfg(feature = "desktop")]
fn queued_commands(root: &Path, cwd: &Path, managed: bool) {
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Waker};
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2)
        .max_blocking_threads(1).enable_all().build().unwrap();
    tauri::async_runtime::set(runtime.handle().clone());
    for identity in [true, false] {
        policy(false, managed);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let path = cwd.to_string_lossy().into_owned();
        let mut command: Pin<Box<dyn Future<Output = bool>>> = if identity {
            Box::pin(async move { crate::commands::github_identity(path, Some(true)).await.unwrap().login.is_some() })
        } else {
            Box::pin(async move { crate::commands::issue_details(path, issue_ops::Provider::Github, "7".into()).await.is_ok() })
        };
        let before = launches(root);
        let mut context = Context::from_waker(Waker::noop());
        assert!(command.as_mut().poll(&mut context).is_pending());
        policy(true, managed);
        policy(false, managed);
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        assert!(!runtime.block_on(command), "queued IPC command revived after restoration");
        assert_eq!(launches(root), before, "queued IPC command launched a network probe");
    }
}
