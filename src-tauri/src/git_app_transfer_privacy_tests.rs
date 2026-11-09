//! Actual branch/worktree/clone/pipeline transfer paths, not a runner substitute.
use super::*;

fn invoke(f: &Fixture, action: &str, sequence: usize) -> bool {
    match action {
        "branch" => crate::branch_overview::fetch(&f.cwd),
        "worktree" => {
            let created = crate::git::create_worktree(&f.cwd, &format!("privacy-{sequence}"), None).unwrap();
            assert!(Path::new(&created.path).join(FILE).exists(), "local creation remains useful");
            let base = created.worktree_base.unwrap();
            if !base.fetched { assert!(base.warning.as_deref().is_some_and(|w| w.contains(data_privacy::MESSAGE))); }
            base.fetched
        }
        "clone" => {
            let parent = f.cwd.parent().unwrap().join(format!("clone-{sequence}"));
            let id = format!("privacy-clone-{sequence}");
            let result = crate::project_start::clone_repository(&id, "git@github.com:privacy/fixture.git", parent.to_str().unwrap(), |_| {});
            if result.is_err() { assert!(!parent.join("fixture/.git").exists(), "cancelled clone was published"); }
            result.is_ok()
        }
        action => crate::issue_pipeline::host::privacy_transfer_entry(&f.cwd, action).is_ok(),
    }
}

fn configure_clone(f: &Fixture) {
    // Clone has no repository yet; it must retain the inherited explicit
    // command/identity rather than substituting the superproject's default.
    std::env::set_var("GIT_SSH_COMMAND", git(&f.cwd, &["config", "--get", "core.sshCommand"]));
    std::env::set_var("GIT_SSH_VARIANT", "simple");
}

fn putty(root: &Path, managed: bool) {
    use std::os::unix::fs::PermissionsExt;
    for variant in ["putty", "plink", "tortoiseplink"] {
        let _environment = Environment::new(root);
        policy(false, managed);
        let f = Fixture::new(root, &format!("transfer-{variant}"));
        let command = git(&f.cwd, &["config", "--get", "core.sshCommand"]);
        let wrapper = f.cwd.parent().unwrap().join("putty-wrapper");
        // A real upload-pack protocol behind strict PuTTY grammar. OpenSSH
        // -S/-o/-p or a capability probe would fail before any transfer.
        std::fs::write(&wrapper, format!(r#"#!/bin/sh
[ "$1" = --identity ] || exit 91
shift
{batch}
[ "$#" = 4 ] && [ "$1" = -P ] && [ "$2" = 2222 ] && [ "$3" = privacy-pull ] || exit 92
shift 2
exec {command} "$@"
"#, batch=if variant == "tortoiseplink" { "[ \"$1\" = -batch ] || exit 93\nshift" } else { "" })).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&f.cwd, &["config", "core.sshCommand", &format!("{} --identity", quote(&wrapper))]);
        git(&f.cwd, &["config", "ssh.variant", variant]);
        git(&f.cwd, &["remote", "set-url", "origin", "ssh://privacy-pull:2222/fixture.git"]);
        let before = f.transfers();
        let plain = Command::new("/usr/bin/git").current_dir(&f.cwd).args(["fetch", "origin"])
            .env("TERMINALX_TEST_ORDINARY_GIT", "1").output().unwrap();
        assert!(plain.status.success(), "{}", String::from_utf8_lossy(&plain.stderr));
        assert!(f.transfers() > before, "ordinary Git must exercise this grammar");
        let before = f.transfers();
        let refuse = || {
            let error = f.workspace("git.fetch").unwrap_err();
            assert!(error.to_string().contains("Cannot verify configured SSH transport containment"), "{error:#}");
            assert_eq!(f.transfers(), before);
        };
        refuse();
        policy(true, managed); denied(f.workspace("git.fetch"));
        policy(false, managed);
        let stale = crate::github_process::queued(|| f.workspace("git.fetch"));
        policy(true, managed); policy(false, managed); denied(stale());
        refuse();
    }
}

fn recursive(root: &Path, managed: bool) {
    let _environment = Environment::new(root);
    policy(false, managed);
    let parent = Fixture::new(root, "recursive-parent");
    let child = Fixture::new(root, "recursive-child");
    let source = parent.cwd.parent().unwrap().join("source");
    git(&source, &["-c", "protocol.file.allow=always", "submodule", "add", child.origin.to_str().unwrap(), "nested/child"]);
    git(&source, &["-c", "commit.gpgsign=false", "commit", "-qam", "Initialize child"]);
    git(&source, &["push", parent.origin.to_str().unwrap(), "main"]);
    parent.workspace("git.pull").unwrap();
    let out = Command::new("/usr/bin/git").current_dir(&parent.cwd)
        .args(["-c", "protocol.file.allow=always", "submodule", "update", "--init"])
        .env_remove("GIT_NO_LAZY_FETCH").output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let nested = parent.cwd.join("nested/child");
    git(&nested, &["remote", "set-url", "origin", "ssh://privacy-pull/fixture.git"]);
    git(&nested, &["config", "core.sshCommand", &git(&child.cwd, &["config", "--get", "core.sshCommand"])]);
    // The file superproject's unused SSH command must NEVER replace the
    // initialized child's identity or variant, even through inherited env.
    git(&parent.cwd, &["remote", "set-url", "origin", &format!("file://{}", parent.origin.display())]);
    git(&parent.cwd, &["config", "core.sshCommand", "/usr/bin/ssh -i parent-only-key"]);
    git(&parent.cwd, &["config", "ssh.variant", "ssh"]);
    git(&parent.cwd, &["config", "fetch.recurseSubmodules", "true"]);
    let source = child.cwd.parent().unwrap().join("source");
    for variant in [None, Some("auto"), Some("simple")] {
        if let Some(variant) = variant { git(&nested, &["config", "ssh.variant", variant]); }
        else { let _ = raw(&nested, &["config", "--unset", "ssh.variant"]); }
        std::fs::write(source.join("new.txt"), format!("{variant:?}\n")).unwrap();
        git(&source, &["add", "."]);
        git(&source, &["-c", "commit.gpgsign=false", "commit", "-qm", "Child changed"]);
        git(&source, &["push", child.origin.to_str().unwrap(), "main"]);
        let expected = git(&source, &["rev-parse", "HEAD"]);
        let before = child.transfers();
        policy(true, managed);
        denied(parent.workspace("git.fetch"));
        policy(false, managed);
        let queued = crate::github_process::queued(|| parent.workspace("git.fetch"));
        policy(true, managed); policy(false, managed);
        denied(queued());
        assert_eq!(child.transfers(), before);
        parent.workspace("git.fetch").unwrap();
        assert_eq!(git(&nested, &["rev-parse", "origin/main"]), expected);
        assert!(child.transfers() > before);
    }
    std::fs::write(&child.hold, "").unwrap();
    std::thread::scope(|scope| {
        let worker = scope.spawn(crate::github_process::queued(|| parent.workspace("git.fetch")));
        let until = Instant::now() + Duration::from_secs(10);
        while !child.held.exists() {
            assert!(Instant::now() < until && !worker.is_finished());
            std::thread::sleep(Duration::from_millis(5));
        }
        policy(true, managed);
        for pid in std::fs::read_to_string(&child.held).unwrap().split_whitespace() {
            assert_eq!(unsafe { libc::kill(pid.parse().unwrap(), 0) }, -1, "recursive transfer survived acknowledgement");
        }
        denied(worker.join().unwrap());
    });
    policy(false, managed);
    std::fs::remove_file(&child.hold).unwrap();
    parent.workspace("git.fetch").unwrap();
}

pub(super) fn run(root: &Path, managed: bool) {
    merge_inputs(root, managed);
    pipeline::run(root, managed);
    putty(root, managed);
    recursive(root, managed);
    for action in ["branch", "worktree", "clone", "push", "read", "fetch"] {
        println!("privacy generic transfer entry: managed={managed}/{action}");
        let _environment = Environment::new(root);
        policy(false, managed);
        let f = Fixture::new(root, &format!("generic-{action}"));
        configure_clone(&f);
        if action == "worktree" { f.workspace("git.pull").unwrap(); }
        if action == "push" { f.workspace("git.pull").unwrap(); f.commit_for_push(); }
        policy(true, managed);
        assert!(!invoke(&f, action, 0));
        let before = f.transfers();
        policy(false, managed);
        let stale = crate::github_process::queued(|| invoke(&f, action, 1));
        policy(true, managed); policy(false, managed);
        assert!(!stale());
        assert_eq!(f.transfers(), before, "enabled/stale {action} transferred");
        assert!(invoke(&f, action, 2), "fresh {action} did not restore");
        assert!(f.transfers() > before);
        assert!(crate::branch_overview::overview(&f.cwd, None).branch.is_some());

        // Pause a real transport, not the queue or a synthetic runner. This
        // fixture's own SSH process and sleeping descendant hold the pipes.
        std::fs::write(f.cwd.parent().unwrap().join("first-fetch"), "").unwrap();
        std::fs::write(&f.hold, "").unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(crate::github_process::queued(|| invoke(&f, action, 3)));
            let deadline = Instant::now() + Duration::from_secs(10);
            let pids: Vec<i32> = loop {
                if let Ok(text) = std::fs::read_to_string(&f.held) {
                    let pids: Vec<_> = text.split_whitespace().map(|s| s.parse().unwrap()).collect();
                    if pids.len() == 2 { break pids; }
                }
                assert!(Instant::now() < deadline && !worker.is_finished(), "no {action} transfer observed");
                std::thread::sleep(Duration::from_millis(5));
            };
            let started = Instant::now();
            policy(true, managed);
            assert!(started.elapsed() < Duration::from_secs(5));
            for pid in pids { assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{action} acknowledged before drain"); }
            assert!(!worker.join().unwrap());
        });
        let before = f.transfers();
        policy(false, managed);
        assert_eq!(f.transfers(), before, "no replay");
        std::fs::remove_file(&f.hold).unwrap();
        assert!(invoke(&f, action, 4));
        assert!(f.transfers() > before);
    }
}

fn merge_inputs(root: &Path, managed: bool) {
    for cycle in [false, true] {
        let _environment = Environment::new(root);
        policy(false, managed);
        let f = Fixture::new(root, &format!("merge-inputs-{cycle}"));
        git(&f.cwd, &["checkout", "-qb", "privacy-conflict"]);
        git(&f.cwd, &["config", "user.name", "Privacy Fixture"]);
        git(&f.cwd, &["config", "user.email", "local@example.test"]);
        std::fs::write(f.cwd.join(FILE), b"diverged\0local picture\n").unwrap();
        git(&f.cwd, &["add", "."]);
        git(&f.cwd, &["-c", "commit.gpgsign=false", "commit", "-qm", "Diverged local input"]);
        let local = git(&f.cwd, &["rev-parse", "HEAD"]);
        f.missing();
        let compare = || crate::issue_pipeline::host::privacy_resolution(&f.cwd);
        let before = f.transfers();
        policy(true, managed);
        assert!(compare().unwrap_err().to_string().contains(data_privacy::MESSAGE));
        assert_eq!(f.transfers(), before);
        policy(false, managed);
        let (arrived_tx, arrived_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *crate::github_process::AFTER_OUTPUT.lock().unwrap() = Some(Box::new(move || {
            arrived_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }));
        std::thread::scope(|scope| {
            let worker = scope.spawn(crate::github_process::queued(compare));
            arrived_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            // The filtered fetch is complete and its process/lease drained.
            assert_eq!(git(&f.cwd, &["rev-parse", "origin/main"]), f.after);
            f.missing();
            let fetched = f.transfers();
            assert!(fetched > before);
            policy(true, managed);
            if cycle { policy(false, managed); }
            release_tx.send(()).unwrap();
            let error = worker.join().unwrap().unwrap_err().to_string();
            assert!(error.contains("locally available base objects"), "missing input must not be reported as clean/conflicting: {error}");
            assert_eq!(f.transfers(), fetched, "merge-tree demanded a promised blob after fetch admission drained");
        });
        f.missing();
        assert_eq!(git(&f.cwd, &["rev-parse", "HEAD"]), local);
        assert_eq!(std::fs::read(f.cwd.join(FILE)).unwrap(), b"diverged\0local picture\n");
        // Agent-owned Git can acquire the absent object, even with mode on.
        policy(true, managed);
        let fetched = f.transfers();
        let object = Command::new("/usr/bin/git").current_dir(&f.cwd).args(["cat-file", "blob", &f.blob])
            .env_remove("GIT_NO_LAZY_FETCH").env("TERMINALX_TEST_ORDINARY_GIT", "1").output().unwrap();
        assert!(object.status.success(), "agent-owned positive control: {}", String::from_utf8_lossy(&object.stderr)); assert_eq!(object.stdout, NEW); assert!(f.transfers() > fetched);
        policy(false, managed);
        let resolution = compare().unwrap().expect("cached binary conflicts remain real conflicts");
        assert_eq!(resolution.head, local); assert_eq!(resolution.base_commit, f.after);
        assert_eq!(std::fs::read(f.cwd.join(FILE)).unwrap(), b"diverged\0local picture\n");
    }
}

#[path = "git_pipeline_transfer_privacy_tests.rs"]
mod pipeline;

#[cfg(feature = "desktop")]
pub(super) fn ipc(root: &Path, managed: bool, runtime: &tokio::runtime::Runtime) {
    restore::run(root, managed, runtime);
    use std::future::Future;
    use std::task::{Context, Waker};
    for action in ["branch", "clone"] {
        let _environment = Environment::new(root);
        let f = Fixture::new(root, &format!("generic-ipc-{action}"));
        configure_clone(&f);
        let progress = Arc::new(std::sync::Mutex::new(Vec::new()));
        let call = |sequence: usize| {
            let progress = progress.clone();
            let cwd = f.cwd.to_string_lossy().into_owned();
            let parent = f.cwd.parent().unwrap().join(format!("ipc-clone-{sequence}")).to_string_lossy().into_owned();
            async move {
                if action == "branch" { crate::commands::branch_fetch(cwd).await.unwrap() }
                else {
                    crate::project_start::clone_queued(format!("ipc-{sequence}"), "git@github.com:privacy/fixture.git".into(), parent,
                        move |event| progress.lock().unwrap().push(event)).await.is_ok()
                }
            }
        };
        policy(true, managed);
        assert!(!runtime.block_on(call(0)));
        policy(false, managed);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(10)).unwrap(); });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut command = Box::pin(call(1));
        assert!(command.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        policy(true, managed); policy(false, managed);
        release_tx.send(()).unwrap(); runtime.block_on(blocker).unwrap();
        assert!(!runtime.block_on(command));
        assert_eq!(f.transfers(), 0, "queued {action} acquired current authority");
        assert!(runtime.block_on(call(2)));
        assert!(f.transfers() > 0);
        if action == "clone" { assert!(!progress.lock().unwrap().is_empty(), "real clone progress must still be emitted"); }
    }
}

#[cfg(feature = "desktop")]
#[path = "git_restore_privacy_tests.rs"]
mod restore;
