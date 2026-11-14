//! Real blob:none clones, with an observed SSH transport serving a real bare
//! repository. These run in BOTH isolated policy children, not mocked Git reads.
use super::*;
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

const PNG: &str = "nested/image [1].png";
const PDF: &str = "document.pdf";
const SVG: &str = "vector.svg";
const OPERATIONS: &[&str] = &["png", "pdf", "svg", "stats", "whitespace", "working"];

struct TransportEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl TransportEnvironment {
    fn isolated() -> Self {
        // These scenarios run sequentially in an isolated policy child. Never
        // let the developer's SSH override redirect the fixture's transport.
        Self(["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"].into_iter().map(|key| {
            let value = std::env::var_os(key);
            std::env::remove_var(key);
            (key, value)
        }).collect())
    }
}
impl Drop for TransportEnvironment {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..) {
            if let Some(value) = value { std::env::set_var(key, value); }
            else { std::env::remove_var(key); }
        }
    }
}

struct Fixture {
    cwd: PathBuf,
    base: String,
    head: String,
    transfers: PathBuf,
    objects: Vec<(String, Vec<u8>)>,
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

fn quoted(path: &Path) -> String { format!("'{}'", path.display().to_string().replace('\'', "'\\''")) }

impl Fixture {
    fn new(root: &Path, name: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = root.join(format!("media-{name}"));
        let source = dir.join("source");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        git(&source, &["init", "-q", "-b", "main"]);
        git(&source, &["config", "user.name", "Privacy Fixture"]);
        git(&source, &["config", "user.email", "local@example.test"]);
        let mut objects = Vec::new();
        let mut trees = Vec::new();
        for revision in ["before", "after"] {
            for path in [PNG, PDF, SVG] {
                let bytes = if path == SVG { format!("<svg>{revision}</svg>\n").into_bytes() }
                    else { format!("{path}\0{revision}\n").into_bytes() };
                std::fs::write(source.join(path), &bytes).unwrap();
                let oid = git(&source, &["hash-object", path]);
                objects.push((oid, bytes));
            }
            git(&source, &["add", "."]);
            git(&source, &["-c", "commit.gpgsign=false", "commit", "-qm", revision]);
            trees.push(git(&source, &["rev-parse", "HEAD^{tree}"]));
        }
        let origin = dir.join("origin.git");
        git(&dir, &["clone", "--bare", source.to_str().unwrap(), origin.to_str().unwrap()]);
        git(&origin, &["config", "uploadpack.allowFilter", "true"]);
        git(&origin, &["config", "uploadpack.allowAnySHA1InWant", "true"]);
        let cwd = dir.join("partial");
        git(&dir, &["clone", "--filter=blob:none", "--no-checkout", &format!("file://{}", origin.display()), cwd.to_str().unwrap()]);
        assert_eq!(git(&cwd, &["config", "--get", "remote.origin.promisor"]), "true");
        assert!(std::fs::read_dir(cwd.join(".git/objects/pack")).unwrap().flatten().any(|e| e.path().extension().is_some_and(|e| e == "promisor")));
        for (oid, _) in &objects {
            assert!(!raw(&cwd, &["cat-file", "-e", oid]).status.success(), "fixture must really omit {oid}");
        }
        git(&cwd, &["read-tree", "HEAD"]);
        std::fs::create_dir_all(cwd.join("nested")).unwrap();
        for path in [PNG, PDF, SVG] { std::fs::write(cwd.join(path), b"local worktree bytes\n").unwrap(); }

        let transfers = dir.join("transfers");
        let ssh = dir.join("observed-ssh");
        // Git speaks the real upload-pack protocol over this process's stdio.
        // Merely observing argv or stubbing the cat-file result would not prove
        // the missing-object fixture can actually demand-fetch and restore.
        std::fs::write(&ssh, format!("#!/bin/sh\nprintf '%s %s\\n' \"$$\" \"$*\" >> {}\nexec /usr/bin/git upload-pack {}\n", quoted(&transfers), quoted(&origin))).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&cwd, &["config", "core.sshCommand", &quoted(&ssh)]);
        git(&cwd, &["config", "ssh.variant", "simple"]);
        git(&cwd, &["remote", "set-url", "origin", "ssh://privacy-media/fixture.git"]);
        Self { cwd, base: trees.remove(0), head: trees.remove(0), transfers, objects }
    }

    fn transfers(&self) -> usize { std::fs::read_to_string(&self.transfers).unwrap_or_default().lines().count() }

    fn workspace(&self, operation: &str) -> Result<Value, String> {
        use crate::remote::{files::WorkspaceFiles, git::WorkspaceGit};
        let workspace = WorkspaceGit::new(self.cwd.clone(), Arc::new(WorkspaceFiles::new(self.cwd.clone())));
        let (method, params) = match operation {
            "png" | "pdf" => ("git.mediaContent", json!({"repo":".", "path":if operation == "png" { PNG } else { PDF }, "tree":self.base})),
            "svg" => ("git.fileContents", json!({"repo":".", "path":SVG, "base":self.base, "head":self.head})),
            "stats" | "whitespace" => ("git.changesBetween", json!({"repo":".", "base":self.base, "head":self.head, "hideWhitespace":operation == "whitespace"})),
            "working" => ("git.workingChanges", json!({"repo":".", "hideWhitespace":true})),
            "diff" => ("git.diff", json!({"repo":".", "path":SVG})),
            _ => unreachable!(),
        };
        workspace.handle(method, &params).unwrap().map_err(|e| e.message)
    }

    #[cfg(feature = "desktop")]
    async fn ipc(&self, operation: &str) -> Result<Value, String> {
        let cwd = self.cwd.to_string_lossy().into_owned();
        match operation {
            "png" | "pdf" => crate::commands::diff_media_content(cwd, if operation == "png" { PNG } else { PDF }.into(), Some(self.base.clone())).await.map(|v| json!(v)),
            "svg" => crate::commands::file_contents_at(cwd, SVG.into(), self.base.clone(), Some(self.head.clone())).await.map(|v| json!(v)),
            "stats" | "whitespace" => crate::commands::changes_between(cwd, self.base.clone(), Some(self.head.clone()), Some(operation == "whitespace")).await.map(|v| json!(v)),
            "working" => crate::commands::working_changes(cwd, Some(true)).await.map(|v| json!(v)),
            _ => unreachable!(),
        }
    }

    fn local_media(&self) {
        let media = crate::git_media::read(&self.cwd, PNG, None, 1024).unwrap().unwrap();
        let value = json!(media);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(value["data"].as_str().unwrap()).unwrap(), b"local worktree bytes\n");
        assert!(crate::git_media::read(&self.cwd, "absent.png", Some(&self.base), 1024).unwrap().is_none());
        assert!(crate::git::blob_at(&self.cwd, &self.base, "absent.svg").unwrap().is_none());
        assert!(crate::git::blob_at(&self.cwd, crate::git::EMPTY_TREE, PNG).unwrap().is_none());
    }

    fn populate_as_agent(&self) {
        let parent_environment = std::env::var_os("GIT_NO_LAZY_FETCH");
        let before = self.transfers();
        for (oid, bytes) in &self.objects {
            // Ordinary agent-owned Git keeps demand fetching, even with the
            // app's personal/managed policy on. Do not use the app Git runner.
            let out = Command::new("/usr/bin/git").current_dir(&self.cwd)
                .args(["cat-file", "blob", oid]).env_remove("GIT_NO_LAZY_FETCH").output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            assert_eq!(&out.stdout, bytes);
        }
        assert!(self.transfers() > before, "positive control must physically start the SSH transport");
        assert_eq!(std::env::var_os("GIT_NO_LAZY_FETCH"), parent_environment, "no application-wide environment mutation");
    }

    fn restored(&self, operation: &str, value: Value) {
        match operation {
            "png" | "pdf" => {
                let bytes = base64::engine::general_purpose::STANDARD.decode(value["data"].as_str().unwrap()).unwrap();
                assert_eq!(bytes, self.objects[usize::from(operation == "pdf")].1);
            }
            "svg" => {
                assert_eq!(value["before"], "<svg>before</svg>\n");
                assert_eq!(value["after"], "<svg>after</svg>\n");
            }
            "diff" => assert!(value["diff"].as_str().unwrap().contains("local worktree bytes")),
            _ => {
                let files = if value.is_object() { &value["files"] }
                    else if operation == "working" { &value[1] } else { &value };
                let files = files.as_array().unwrap();
                assert_eq!(files.len(), 3);
                assert!(files.iter().any(|file| file["path"] == PNG));
                for file in files {
                    let path = file["path"].as_str().unwrap();
                    let expected = if operation == "working" { git(&self.cwd, &["hash-object", path]) }
                        else { git(&self.cwd, &["rev-parse", &format!("{}:{path}", self.head)]) };
                    assert_eq!(file["blobHash"], expected, "review identity must name the actual snapshot blob");
                }
            }
        }
    }
}

fn unavailable(answer: Result<Value, String>, operation: &str) {
    let error = answer.expect_err("missing promised objects must not become an absent revision or an implicit fetch");
    if matches!(operation, "png" | "pdf" | "svg") { assert!(error.contains("unavailable locally"), "{error}"); }
}

struct Hold(PathBuf);
impl Drop for Hold { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }

/// Hold an actual app Git child immediately before its object read. It may
/// finish local work after acknowledgement; it can never initiate a transfer,
/// including when privacy has been switched off again before the read runs.
fn during_read<T: Send>(root: &Path, managed: bool, restore: bool, read: impl FnOnce() -> T + Send) -> T {
    let entered = root.join("media-cat-entered");
    let _ = std::fs::remove_file(&entered);
    policy(false, managed);
    std::thread::scope(|scope| {
        let hold = Hold(root.join("media-cat-hold"));
        std::fs::write(&hold.0, "").unwrap();
        let worker = scope.spawn(read);
        let deadline = Instant::now() + Duration::from_secs(10);
        let marker = loop {
            if let Ok(text) = std::fs::read_to_string(&entered) {
                if text.split_whitespace().count() == 2 { break text; }
            }
            assert!(Instant::now() < deadline && !worker.is_finished(), "no observed object-read child");
            std::thread::sleep(Duration::from_millis(5));
        };
        let fields: Vec<_> = marker.split_whitespace().collect();
        assert_eq!(fields[1], "1", "no-lazy-fetch must be present on the physical child");
        let pid: i32 = fields[0].parse().unwrap();
        policy(true, managed);
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "the active child is local work, not an admitted transfer");
        if restore { policy(false, managed); }
        drop(hold);
        worker.join().unwrap()
    })
}

pub(super) fn run(root: &Path, managed: bool) {
    let _transport = TransportEnvironment::isolated();
    let fixture = Fixture::new(root, "workspace");
    for operation in OPERATIONS.iter().copied().chain(["diff"]) {
        println!("privacy partial-clone WorkspaceGit: managed={managed}/{operation}");
        policy(true, managed);
        unavailable(fixture.workspace(operation), operation);
        fixture.local_media();
        policy(false, managed);
        let queued = crate::github_process::queued(|| fixture.workspace(operation));
        policy(true, managed); policy(false, managed);
        unavailable(queued(), operation);
        unavailable(fixture.workspace(operation), operation);
        assert_eq!(fixture.transfers(), 0, "no implicit transfer while enabled, stale or freshly off");
    }
    for restore in [false, true] {
        unavailable(during_read(root, managed, restore, || fixture.workspace("png")), "png");
        assert_eq!(fixture.transfers(), 0, "active object read crossed the network boundary");
    }
    policy(true, managed);
    fixture.populate_as_agent();
    let before = fixture.transfers();
    for operation in OPERATIONS.iter().copied().chain(["diff"]) { fixture.restored(operation, fixture.workspace(operation).unwrap()); }
    policy(false, managed);
    for operation in OPERATIONS.iter().copied().chain(["diff"]) { fixture.restored(operation, fixture.workspace(operation).unwrap()); }
    assert_eq!(fixture.transfers(), before, "cached reads and policy restoration never fetch again");
}

#[cfg(feature = "desktop")]
pub(super) fn ipc_queues(root: &Path, managed: bool, runtime: &tokio::runtime::Runtime) {
    use std::future::Future;
    use std::task::{Context, Waker};
    let _transport = TransportEnvironment::isolated();
    let fixture = Fixture::new(root, "ipc");
    for &operation in OPERATIONS {
        println!("privacy partial-clone desktop IPC: managed={managed}/{operation}");
        policy(true, managed);
        unavailable(runtime.block_on(fixture.ipc(operation)), operation);
        let cwd = fixture.cwd.to_string_lossy().into_owned();
        assert!(runtime.block_on(crate::commands::diff_media_content(cwd.clone(), PNG.into(), None)).unwrap().is_some());
        assert!(runtime.block_on(crate::commands::diff_media_content(cwd, "absent.png".into(), Some(fixture.base.clone()))).unwrap().is_none());
        policy(false, managed);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(10)).unwrap(); });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut command = Box::pin(fixture.ipc(operation));
        assert!(command.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        policy(true, managed); policy(false, managed);
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        unavailable(runtime.block_on(command), operation);
        unavailable(runtime.block_on(fixture.ipc(operation)), operation);
        assert_eq!(fixture.transfers(), 0, "queued IPC must stay local after restoration");
    }
    for restore in [false, true] {
        unavailable(during_read(root, managed, restore, || runtime.block_on(fixture.ipc("pdf"))), "pdf");
        assert_eq!(fixture.transfers(), 0);
    }
    policy(true, managed);
    fixture.populate_as_agent();
    let before = fixture.transfers();
    for &operation in OPERATIONS { fixture.restored(operation, runtime.block_on(fixture.ipc(operation)).unwrap()); }
    policy(false, managed);
    for &operation in OPERATIONS { fixture.restored(operation, runtime.block_on(fixture.ipc(operation)).unwrap()); }
    assert_eq!(fixture.transfers(), before);
    relay_scope_reads(&fixture, managed, runtime);
}

/// Commit/turn review still uses the original remote request admission even
/// though all its Git inspection is local-only. A restored connection may
/// issue fresh reads, but queued reads from an older generation cannot revive.
#[cfg(feature = "desktop")]
fn relay_scope_reads(fixture: &Fixture, managed: bool, runtime: &tokio::runtime::Runtime) {
    use std::future::Future;
    use std::task::{Context, Waker};
    use crate::remote::{protocol::{Authority, PROTOCOL}, server::{Peer, WorkspaceRpc}};
    let rpc = WorkspaceRpc::new(&fixture.cwd, 1, Arc::new(crate::sink::BroadcastSink::new(64)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
    let (peer, _events) = Peer::for_user("scope-reader".into(), Authority::Participate, Some("scope-reader".into()));
    let hello = json!({"id":"hello","method":"rpc.hello","params":{"protocol":PROTOCOL,"want":["git/1"]}});
    assert_eq!(runtime.block_on(rpc.handle(&peer, &hello))["ok"], true);
    let request = |method: &str| json!({"id":uuid::Uuid::new_v4().to_string(),"method":method,"params":{
        "repo":".","base":fixture.base,"head":fixture.head,"limit":1,"target":"main","uncommitted":false}});
    // Participation alone is not workspace access. Prove the early refusal,
    // then supply a real viewer membership so the queue tests reach execution.
    let unknown = runtime.block_on(rpc.handle_owned(peer.clone(), request("git.log")));
    assert_eq!(unknown["error"]["data"]["reason"], "access-unknown");
    rpc.set_collaboration(Some(serde_json::from_value(json!({"v":1,"members":[
        {"userId":"scope-reader","role":"viewer","canApprove":false}
    ]})).unwrap()));
    let allowed = runtime.block_on(rpc.handle_owned(peer.clone(), request("git.log")));
    assert_eq!(allowed["ok"], true, "{allowed}");
    assert_eq!(allowed["result"]["commits"].as_array().unwrap().len(), 1);
    let refused = |answer: Value| {
        assert_eq!(answer["ok"], false, "{answer}");
        assert_eq!(answer["error"]["code"], "forbidden", "{answer}");
        assert_eq!(answer["error"]["message"], data_privacy::MESSAGE);
    };
    let before = fixture.transfers();
    for method in ["git.log", "git.branches", "git.reviewRange", "git.changesBetween"] {
        policy(true, managed);
        refused(runtime.block_on(rpc.handle_owned(peer.clone(), request(method))));
        // Local commit metadata remains available while remote control is off.
        assert_eq!(crate::git::log_commits(&fixture.cwd, None, 1).unwrap().len(), 1);
        policy(false, managed);
        let queued = rpc.handle_owned(peer.clone(), request(method));
        policy(true, managed); policy(false, managed);
        refused(runtime.block_on(queued));
        let (entered, arrived) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered.send(()).unwrap(); released.recv_timeout(Duration::from_secs(10)).unwrap(); });
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut queued = Box::pin(rpc.handle_owned(peer.clone(), request(method)));
        { let _runtime = runtime.enter(); let state = queued.as_mut().poll(&mut Context::from_waker(Waker::noop())); assert!(state.is_pending(), "{method} bypassed the blocking queue: {state:?}"); }
        policy(true, managed); policy(false, managed);
        release.send(()).unwrap(); runtime.block_on(blocker).unwrap();
        refused(runtime.block_on(queued));
        let fresh = runtime.block_on(rpc.handle_owned(peer.clone(), request(method)));
        assert_eq!(fresh["ok"], true, "{fresh}");
        if method == "git.changesBetween" { fixture.restored("stats", fresh["result"].clone()); }
    }
    let (entered, arrived) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    *crate::remote::server::BEFORE_REMOTE_WORK.lock().unwrap() = Some(Box::new(move || {
        assert!(data_privacy::remote_ticket().is_some());
        entered.send(()).unwrap(); released.recv_timeout(Duration::from_secs(10)).unwrap();
    }));
    let pending = runtime.spawn(rpc.handle_owned(peer.clone(), request("git.changesBetween")));
    arrived.recv_timeout(Duration::from_secs(5)).unwrap();
    let (acknowledged, ack) = std::sync::mpsc::channel();
    let activation = std::thread::spawn(move || { policy(true, managed); acknowledged.send(()).unwrap(); });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !data_privacy::enabled() { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(5)); }
    assert!(ack.recv_timeout(Duration::from_millis(100)).is_err(), "remote read admission ended before its work finished");
    release.send(()).unwrap();
    let completed = runtime.block_on(pending).unwrap();
    assert_eq!(completed["ok"], true, "{completed}");
    fixture.restored("stats", completed["result"].clone());
    ack.recv_timeout(Duration::from_secs(5)).unwrap(); activation.join().unwrap();
    policy(false, managed);
    assert_eq!(runtime.block_on(rpc.handle_owned(peer, request("git.log")))["ok"], true);
    assert_eq!(fixture.transfers(), before, "scope reads must never implicitly fetch");
}
