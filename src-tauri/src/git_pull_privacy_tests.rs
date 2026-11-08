//! Real partial-clone pulls through WorkspaceGit and desktop IPC. The observed
//! transport serves Git's protocol; neither fetch nor checkout is substituted.
use super::*;
use std::path::PathBuf;
use std::sync::Arc;

const FILE: &str = "picture.png";
const OLD: &[u8] = b"old\0image\n";
const NEW: &[u8] = b"new\0promised image\n";

struct Environment {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    marker: PathBuf,
    owns_marker: bool,
}

impl Environment {
    fn new(root: &Path) -> Self {
        // Only the already-isolated personal/managed child mutates these.
        let saved = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT", "GIT_NO_LAZY_FETCH"].into_iter().map(|key| {
            let value = std::env::var_os(key);
            std::env::remove_var(key);
            (key, value)
        }).collect();
        let marker = root.join("real-pull");
        // Nested SSH/transfer fixtures share the enclosing real-Git scope.
        // Only its creator may remove the marker on exit.
        let owns_marker = match std::fs::OpenOptions::new().write(true).create_new(true).open(&marker) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(error) => panic!("real-Git fixture marker: {error}"),
        };
        Self { saved, marker, owns_marker }
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        if self.owns_marker { let _ = std::fs::remove_file(&self.marker); }
        for (key, value) in self.saved.drain(..) {
            if let Some(value) = value { std::env::set_var(key, value); }
            else { std::env::remove_var(key); }
        }
    }
}

fn raw(cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new("/usr/bin/git").current_dir(cwd).args(args)
        .env("GIT_NO_LAZY_FETCH", "1").output().unwrap()
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = raw(cwd, args);
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().into()
}

fn quote(path: &Path) -> String { format!("'{}'", path.display().to_string().replace('\'', "'\\''")) }

struct Fixture {
    cwd: PathBuf,
    origin: PathBuf,
    before: String,
    after: String,
    blob: String,
    transfers: PathBuf,
    hold: PathBuf,
    held: PathBuf,
}

impl Fixture {
    fn new(root: &Path, name: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = root.join(format!("pull-{name}"));
        let source = dir.join("source");
        std::fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "-q", "-b", "main"]);
        git(&source, &["config", "user.name", "Privacy Fixture"]);
        git(&source, &["config", "user.email", "local@example.test"]);
        std::fs::write(source.join(FILE), OLD).unwrap();
        git(&source, &["add", "."]);
        git(&source, &["-c", "commit.gpgsign=false", "commit", "-qm", "Old checkout"]);
        let before = git(&source, &["rev-parse", "HEAD"]);
        let origin = dir.join("origin.git");
        git(&dir, &["clone", "--bare", source.to_str().unwrap(), origin.to_str().unwrap()]);
        git(&origin, &["config", "uploadpack.allowFilter", "true"]);
        git(&origin, &["config", "uploadpack.allowAnySHA1InWant", "true"]);
        let cwd = dir.join("partial");
        // Fixture setup checks out the old revision, including its promised
        // blob. App execution below must acquire a different, initially absent
        // blob after fetching a new commit with the retained blob:none filter.
        let clone = Command::new("/usr/bin/git").current_dir(&dir)
            .args(["clone", "--filter=blob:none", &format!("file://{}", origin.display()), cwd.to_str().unwrap()])
            .env_remove("GIT_NO_LAZY_FETCH").output().unwrap();
        assert!(clone.status.success(), "{}", String::from_utf8_lossy(&clone.stderr));
        assert_eq!(git(&cwd, &["config", "--get", "remote.origin.promisor"]), "true");
        assert_eq!(git(&cwd, &["config", "--get", "remote.origin.partialclonefilter"]), "blob:none");
        assert!(std::fs::read_dir(cwd.join(".git/objects/pack")).unwrap().flatten().any(|e| e.path().extension().is_some_and(|e| e == "promisor")));
        std::fs::write(source.join(FILE), NEW).unwrap();
        git(&source, &["add", "."]);
        git(&source, &["-c", "commit.gpgsign=false", "commit", "-qm", "New promised blob"]);
        let after = git(&source, &["rev-parse", "HEAD"]);
        let blob = git(&source, &["hash-object", FILE]);
        git(&source, &["push", origin.to_str().unwrap(), "main"]);

        let transfers = dir.join("transfers");
        let hold = dir.join("hold-objects");
        let held = dir.join("held");
        let first = dir.join("first-fetch");
        let ssh = dir.join("configured-ssh");
        // A simple configured transport accepts exactly its identity argument,
        // host and remote command. First transfer fetches refs with blob:none;
        // second transfer is checkout's demanded object. Hold that second call,
        // including a pipe-owning child that ignores SIGTERM, to require the
        // runner's hard group cleanup before privacy can acknowledge.
        std::fs::write(&ssh, format!(r#"#!/bin/sh
[ "$#" = 3 ] && [ "$1" = --fixture-key ] || exit 92
case "$2" in privacy-pull|git@github.com) ;; *) exit 92 ;; esac
printf '%s %s %s\n' "$$" "${{GIT_NO_LAZY_FETCH:-unset}}" "$*" >> {transfers}
case "$3" in
 git-receive-pack*|git-upload-pack*) ;;
 *) exit 93 ;;
esac
if [ ! -f {first} ]; then
 : > {first}
elif [ -f {hold} ]; then
 trap '' TERM
 /bin/sleep 15 &
 child=$!
 printf '%s %s\n' "$$" "$child" > {held}.tmp
 /bin/mv {held}.tmp {held}
 wait "$child"
 exit 94
fi
case "$3" in
 git-receive-pack*) exec /usr/bin/git receive-pack {origin} ;;
 *) exec /usr/bin/git upload-pack {origin} ;;
esac
"#, transfers=quote(&transfers), origin=quote(&origin), first=quote(&first), hold=quote(&hold), held=quote(&held))).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&cwd, &["config", "core.sshCommand", &format!("{} --fixture-key", quote(&ssh))]);
        git(&cwd, &["config", "ssh.variant", "simple"]);
        git(&cwd, &["remote", "set-url", "origin", "ssh://privacy-pull/fixture.git"]);
        let fixture = Self { cwd, origin, before, after, blob, transfers, hold, held };
        fixture.unchanged();
        fixture.missing();
        fixture
    }

    fn transfers(&self) -> usize { std::fs::read_to_string(&self.transfers).unwrap_or_default().lines().count() }

    fn unchanged(&self) {
        assert_eq!(git(&self.cwd, &["rev-parse", "HEAD"]), self.before);
        assert_eq!(std::fs::read(self.cwd.join(FILE)).unwrap(), OLD);
    }

    fn missing(&self) {
        assert!(!raw(&self.cwd, &["cat-file", "-e", &self.blob]).status.success(), "new blob must remain absent; assertion cannot demand-fetch it");
    }

    fn updated(&self) {
        assert_eq!(git(&self.cwd, &["rev-parse", "HEAD"]), self.after);
        assert_eq!(std::fs::read(self.cwd.join(FILE)).unwrap(), NEW);
        assert!(self.transfers() >= 2, "exercise both filtered ref fetch and checkout's object fetch");
        assert!(std::fs::read_to_string(&self.transfers).unwrap().lines().all(|line| line.split_whitespace().nth(1) == Some("unset")), "inspection override must not leak into the admitted transfer");
        assert_eq!(git(&self.cwd, &["config", "--get", "remote.origin.partialclonefilter"]), "blob:none");
    }

    fn workspace(&self, operation: &str) -> Result<(), String> {
        use crate::remote::{files::WorkspaceFiles, git::WorkspaceGit};
        let workspace = WorkspaceGit::new(self.cwd.clone(), Arc::new(WorkspaceFiles::new(self.cwd.clone())));
        workspace.handle(operation, &serde_json::json!({"repo":"."})).unwrap().map(|_| ()).map_err(|e| e.message)
    }

    #[cfg(feature = "desktop")]
    async fn ipc(&self, operation: &str) -> Result<(), String> {
        let cwd = self.cwd.to_string_lossy().into_owned();
        match operation {
            "git.pull" => crate::commands::git_pull(cwd).await.map(|_| ()),
            "git.push" => crate::commands::git_push(cwd).await.map(|_| ()),
            _ => unreachable!(),
        }
    }

    fn commit_for_push(&self) -> String {
        git(&self.cwd, &["config", "user.name", "Privacy Fixture"]);
        git(&self.cwd, &["config", "user.email", "local@example.test"]);
        std::fs::write(self.cwd.join("local.txt"), "local edit\n").unwrap();
        git(&self.cwd, &["add", "."]);
        git(&self.cwd, &["-c", "commit.gpgsign=false", "commit", "-qm", "Local edit"]);
        git(&self.cwd, &["rev-parse", "HEAD"])
    }
}

fn denied(answer: Result<(), String>) {
    assert!(answer.unwrap_err().contains(data_privacy::MESSAGE));
}

fn exercise(root: &Path, managed: bool, name: &str, pull: impl Fn(&Fixture) -> Result<(), String> + Sync) {
    println!("privacy explicit partial-clone pull: managed={managed}/{name}");
    policy(false, managed);
    let normal = Fixture::new(root, &format!("{name}-normal"));
    pull(&normal).unwrap();
    normal.updated();

    let refused = Fixture::new(root, &format!("{name}-refused"));
    policy(true, managed);
    denied(pull(&refused));
    refused.unchanged();
    assert_eq!(refused.transfers(), 0);
    policy(false, managed);
    let queued = crate::github_process::queued(|| pull(&refused));
    policy(true, managed); policy(false, managed);
    denied(queued());
    refused.unchanged();
    refused.missing();
    assert_eq!(refused.transfers(), 0, "expired requests cannot acquire fresh authority");
    pull(&refused).unwrap();
    refused.updated();

    let cancelled = Fixture::new(root, &format!("{name}-cancelled"));
    std::fs::write(&cancelled.hold, "").unwrap();
    std::thread::scope(|scope| {
        let worker = scope.spawn(crate::github_process::queued(|| pull(&cancelled)));
        let deadline = Instant::now() + Duration::from_secs(10);
        let pids: Vec<i32> = loop {
            if let Ok(text) = std::fs::read_to_string(&cancelled.held) {
                let pids: Vec<i32> = text.split_whitespace().map(|s| s.parse().unwrap()).collect();
                if pids.len() == 2 { break pids; }
            }
            assert!(Instant::now() < deadline && !worker.is_finished(), "no observed checkout object fetch");
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(git(&cancelled.cwd, &["rev-parse", "origin/main"]), cancelled.after, "initial filtered fetch must have completed");
        cancelled.missing();
        cancelled.unchanged();
        assert!(cancelled.cwd.join(".git/index.lock").exists(), "pause inside checkout, while Git owns its index lock");
        let owner: i32 = std::fs::read_to_string(root.join("pull-owner")).unwrap().trim().parse().unwrap();
        assert_eq!(unsafe { libc::getpgid(pids[0]) }, owner, "observe the admitted process group");
        assert_eq!(unsafe { libc::getpgid(pids[1]) }, owner);
        let started = Instant::now();
        policy(true, managed);
        assert!(started.elapsed() < Duration::from_secs(5), "activation waited for held transfer instead of cancelling");
        for pid in pids.into_iter().chain([owner]) {
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "acknowledgement preceded transfer death/drain");
        }
        denied(worker.join().unwrap());
    });
    assert!(!cancelled.cwd.join(".git/index.lock").exists(), "Git must clean its own checkout lock on cancellation");
    cancelled.unchanged();
    cancelled.missing();
    let count = cancelled.transfers();
    policy(false, managed);
    assert_eq!(cancelled.transfers(), count, "restoring policy must not replay the cancelled pull");
    std::fs::remove_file(&cancelled.hold).unwrap();
    pull(&cancelled).unwrap();
    cancelled.updated();
}

pub(super) fn run(root: &Path, managed: bool) {
    let _environment = Environment::new(root);
    exercise(root, managed, "workspace", |f| f.workspace("git.pull"));
    let push = Fixture::new(root, "workspace-push");
    push.workspace("git.pull").unwrap();
    let commit = push.commit_for_push();
    let before = push.transfers();
    policy(true, managed);
    denied(push.workspace("git.push"));
    policy(false, managed);
    let queued = crate::github_process::queued(|| push.workspace("git.push"));
    policy(true, managed); policy(false, managed);
    denied(queued());
    assert_eq!(push.transfers(), before);
    assert_eq!(git(&push.origin, &["rev-parse", "main"]), push.after);
    push.workspace("git.push").unwrap();
    assert_eq!(git(&push.origin, &["rev-parse", "main"]), commit);
    assert!(push.transfers() > before);
    transfers::run(root, managed);
    openssh::run(root, managed, None);
}

#[cfg(feature = "desktop")]
pub(super) fn ipc_queues(root: &Path, managed: bool, runtime: &tokio::runtime::Runtime) {
    use std::future::Future;
    use std::task::{Context, Waker};
    let _environment = Environment::new(root);
    transfers::ipc(root, managed, runtime);
    openssh::run(root, managed, Some(runtime));
    // Covers normal/denied/active cancellation using the actual async command.
    exercise(root, managed, "ipc", |f| runtime.block_on(f.ipc("git.pull")));
    for operation in ["git.pull", "git.push"] {
        let fixture = Fixture::new(root, &format!("ipc-queue-{operation}"));
        let expected = if operation == "git.push" {
            runtime.block_on(fixture.ipc("git.pull")).unwrap();
            Some(fixture.commit_for_push())
        } else { None };
        let before = fixture.transfers();
        policy(true, managed);
        denied(runtime.block_on(fixture.ipc(operation)));
        policy(false, managed);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut command = Box::pin(fixture.ipc(operation));
        assert!(command.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        policy(true, managed); policy(false, managed);
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        denied(runtime.block_on(command));
        assert_eq!(fixture.transfers(), before, "actual queued IPC revived after off/on");
        if operation == "git.pull" { fixture.unchanged(); fixture.missing(); }
        else { assert_eq!(git(&fixture.origin, &["rev-parse", "main"]), fixture.after); }
        runtime.block_on(fixture.ipc(operation)).unwrap();
        if let Some(commit) = expected { assert_eq!(git(&fixture.origin, &["rev-parse", "main"]), commit); }
        else { fixture.updated(); }
        assert!(fixture.transfers() > before);
    }
}

#[path = "git_app_transfer_privacy_tests.rs"]
mod transfers;
#[path = "git_openssh_privacy_tests.rs"]
mod openssh;

pub(super) fn native_review_ssh(root: &Path, managed: bool) {
    openssh::identity(root, managed);
    openssh::run(root, managed, None);
}
