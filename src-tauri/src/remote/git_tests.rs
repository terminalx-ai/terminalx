//! `git/1` against real repositories: a local bare remote stands in for
//! GitHub's Git side and `scripts/remote-runtime/fake-gh` for its API.

use std::io::{Read, Write};
use std::net::TcpListener;

use serde_json::{json, Value};

use super::*;

const ME: &str = r#"{"name":"Ada Lovelace","email":"ada@example.com"}"#;

fn me() -> Value {
    serde_json::from_str(ME).unwrap()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=Other", "-c", "user.email=other@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Fixture {
    _dir: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    state: PathBuf,
    git: WorkspaceGit,
}

impl Fixture {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.git.handle(method, &params).expect("a git method")
    }

    fn code(&self, method: &str, params: Value) -> &'static str {
        self.call(method, params).expect_err("expected a refusal").code
    }

    /// A bare remote with one commit on `main` (and `develop`).
    fn remote(&self, name: &str) -> PathBuf {
        let bare = self.base.join(format!("{name}.git"));
        git(&self.base, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        let seed = self.base.join(format!("{name}-seed"));
        git(&self.base, &["clone", "-q", bare.to_str().unwrap(), seed.to_str().unwrap()]);
        std::fs::write(seed.join("README.md"), "hello\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-q", "-m", "seed"]);
        git(&seed, &["push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/develop"]);
        git(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        bare
    }

    /// Clone `remote` into the workspace at `path`.
    fn clone(&self, remote: &Path, path: &str) -> PathBuf {
        let target = self.root.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        git(&self.root, &["clone", "-q", remote.to_str().unwrap(), target.to_str().unwrap()]);
        target
    }

    fn fault(&self, name: &str) {
        std::fs::write(self.state.join(name), "").unwrap();
    }

    fn gh_calls(&self) -> String {
        std::fs::read_to_string(self.state.join("calls.log")).unwrap_or_default()
    }
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let root = base.join("workspace");
    let state = base.join("github");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/remote-runtime/fake-gh");
    let shim = base.join("gh");
    std::fs::write(&shim, format!("#!/bin/sh\nFAKE_GH_STATE='{}' exec '{}' \"$@\"\n", state.display(), fake.display())).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut workspace = WorkspaceGit::new(root.clone(), Arc::new(WorkspaceFiles::new(root.clone())));
    workspace.set_gh(shim);
    Fixture { _dir: dir, base, root, state, git: workspace }
}

#[test]
fn several_repositories_are_listed_and_an_unnamed_call_is_refused_as_ambiguous() {
    let f = fixture();
    let remote = f.remote("origin");
    f.clone(&remote, "app");
    f.clone(&remote, "libs/core");
    f.clone(&remote, "node_modules/dep");
    f.clone(&remote, ".cache/hidden");
    std::fs::create_dir_all(f.root.join("notes")).unwrap();

    let listed = f.call("git.repositories", json!({})).unwrap();
    let names: Vec<&str> = listed["repositories"].as_array().unwrap().iter().map(|repo| repo["repo"].as_str().unwrap()).collect();
    assert_eq!(names, ["app", "libs/core"]);
    assert_eq!(listed["repositories"][0]["defaultBranch"], "main");

    // No silent pick: every method refuses without `repo`, reads included.
    assert_eq!(f.code("git.status", json!({})), "ambiguous_repository");
    std::fs::write(f.root.join("app/new.txt"), "x").unwrap();
    assert_eq!(f.code("git.commit", json!({ "message": "m", "author": me() })), "ambiguous_repository");
    assert_eq!(f.code("git.push", json!({})), "ambiguous_repository");

    // Each repository is its own, and nothing crosses between them.
    let app = f.call("git.status", json!({ "repo": "app" })).unwrap();
    assert_eq!(app["repo"], "app");
    assert_eq!(app["files"][0]["path"], "new.txt");
    let core = f.call("git.status", json!({ "repo": "libs/core" })).unwrap();
    assert_eq!(core["files"], json!([]));
    assert_eq!(f.code("git.status", json!({ "repo": "notes" })), "not_found");
    assert_eq!(f.code("git.status", json!({ "repo": "../workspace/app" })), "not_found");
}

#[test]
fn a_single_repository_is_used_without_naming_it_and_a_workspace_without_one_says_so() {
    let f = fixture();
    assert_eq!(f.call("git.status", json!({})).unwrap(), json!({ "repository": false }));
    assert_eq!(f.code("git.log", json!({})), "not_found");
    let remote = f.remote("origin");
    f.clone(&remote, "only");
    assert_eq!(f.call("git.status", json!({})).unwrap()["repo"], "only");
}

#[test]
fn commits_carry_the_callers_identity_never_the_workspaces() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();

    assert_eq!(f.code("git.commit", json!({ "repo": "app", "message": "m" })), "invalid_params");
    for author in [json!({ "name": "", "email": "a@b.c" }), json!({ "name": "A", "email": "nope" }), json!({ "name": "A\nB", "email": "a@b.c" }), json!({ "name": "A <x>", "email": "a@b.c" })] {
        assert_eq!(f.code("git.commit", json!({ "repo": "app", "message": "m", "author": author })), "invalid_params");
    }
    let commit = f.call("git.commit", json!({ "repo": "app", "message": "add a", "author": me() })).unwrap();
    assert_eq!(commit["branch"], "main");
    let who = git(&repo, &["log", "-1", "--format=%an <%ae> / %cn <%ce>"]);
    assert_eq!(who, "Ada Lovelace <ada@example.com> / Ada Lovelace <ada@example.com>");
    assert_eq!(f.code("git.commit", json!({ "repo": "app", "message": "again", "author": me() })), "invalid_params");

    // Staged only: what is not staged stays out.
    std::fs::write(repo.join("staged.txt"), "s").unwrap();
    std::fs::write(repo.join("loose.txt"), "l").unwrap();
    f.call("git.stage", json!({ "repo": "app", "paths": ["staged.txt"] })).unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "staged", "author": me(), "staged": true })).unwrap();
    assert_eq!(git(&repo, &["show", "--name-only", "--format=", "HEAD"]), "staged.txt");
    let status = f.call("git.status", json!({ "repo": "app" })).unwrap();
    assert_eq!(status["files"][0]["path"], "loose.txt");
    assert_eq!(status["ahead"], 2);
}

#[test]
fn paths_are_repository_relative_and_pathspec_magic_is_literal() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    std::fs::write(f.root.join("outside.txt"), "x").unwrap();
    assert_eq!(f.code("git.stage", json!({ "repo": "app", "paths": ["../outside.txt"] })), "path_forbidden");
    assert_eq!(f.code("git.stage", json!({ "repo": "app", "paths": ["/etc/passwd"] })), "path_forbidden");
    // `:(top)*` would stage everything if it were a pathspec.
    std::fs::write(repo.join("a.txt"), "a").unwrap();
    assert!(f.call("git.stage", json!({ "repo": "app", "paths": [":(top)*"] })).is_err());
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "");

    // A working-tree read never follows a link out of the workspace.
    #[cfg(unix)]
    {
        std::fs::write(f.base.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(f.base.join("secret.txt"), repo.join("leak.txt")).unwrap();
        let head = f.call("git.workingChanges", json!({ "repo": "app" })).unwrap()["head"].as_str().unwrap().to_string();
        assert_eq!(f.code("git.fileContents", json!({ "repo": "app", "path": "leak.txt", "base": head })), "path_forbidden");
    }
}

#[test]
fn working_changes_and_file_contents_mirror_the_desktop_commands() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    std::fs::write(repo.join("README.md"), "hello\nworld\n").unwrap();
    std::fs::write(repo.join("new.txt"), "new\n").unwrap();
    let changes = f.call("git.workingChanges", json!({ "repo": "app" })).unwrap();
    let head = changes["head"].as_str().unwrap();
    let files: Vec<(&str, &str)> = changes["files"].as_array().unwrap().iter().map(|file| (file["path"].as_str().unwrap(), file["status"].as_str().unwrap())).collect();
    assert_eq!(files, [("README.md", "modified"), ("new.txt", "added")]);
    let pair = f.call("git.fileContents", json!({ "repo": "app", "path": "README.md", "base": head })).unwrap();
    assert_eq!(pair, json!({ "before": "hello\n", "after": "hello\nworld\n" }));

    // A commit's changes, by the trees `git.log` reports.
    f.call("git.commit", json!({ "repo": "app", "message": "second", "author": me() })).unwrap();
    let log = f.call("git.log", json!({ "repo": "app", "limit": 5 })).unwrap();
    let commits = log["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 2);
    let parent = f.call("git.log", json!({ "repo": "app", "from": commits[0]["parent"], "limit": 1 })).unwrap();
    let between = f.call("git.changesBetween", json!({ "repo": "app", "base": parent["commits"][0]["tree"], "head": commits[0]["tree"] })).unwrap();
    assert_eq!(between["files"].as_array().unwrap().len(), 2);
    assert_eq!(f.code("git.changesBetween", json!({ "repo": "app", "base": "HEAD~1" })), "invalid_params");
}

#[test]
fn push_publishes_a_new_branch_and_a_repeat_is_reconciled_without_pushing_again() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    f.call("git.checkout", json!({ "repo": "app", "branch": "feature/x", "create": true, "from": "origin/main" })).unwrap();
    std::fs::write(repo.join("x.txt"), "x").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "x", "author": me() })).unwrap();

    let pushed = f.call("git.push", json!({ "repo": "app" })).unwrap();
    assert_eq!(pushed["branch"], "feature/x");
    assert_eq!(pushed["pushed"], true);
    assert_eq!(pushed["reconciled"], false);
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/feature/x"]), pushed["head"].as_str().unwrap());
    let status = f.call("git.status", json!({ "repo": "app" })).unwrap();
    assert_eq!(status["upstream"], "origin/feature/x");
    assert_eq!(status["ahead"], 0);

    // The answer was lost and the runtime restarted (no idempotency cache):
    // the remote already has it, so nothing is pushed.
    let again = f.call("git.push", json!({ "repo": "app" })).unwrap();
    assert_eq!((again["pushed"].clone(), again["reconciled"].clone()), (json!(false), json!(true)));
}

#[test]
fn a_push_that_lands_before_the_connection_drops_is_reported_as_pushed() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    std::fs::write(repo.join("x.txt"), "x").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "x", "author": me() })).unwrap();
    let answer = f
        .git
        .push_with(&json!({ "repo": "app" }), |repo, branch| {
            git(&repo.dir, &["push", "-q", "origin", branch]);
            Ok(Ran { ok: false, stdout: String::new(), stderr: "fatal: the remote end hung up unexpectedly".into(), timed_out: false })
        })
        .unwrap();
    assert_eq!((answer["pushed"].clone(), answer["reconciled"].clone()), (json!(true), json!(true)));

    // One that did not land is `outcome_unknown`, and says a retry checks first.
    std::fs::write(repo.join("y.txt"), "y").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "y", "author": me() })).unwrap();
    let error = f
        .git
        .push_with(&json!({ "repo": "app" }), |_, _| Ok(Ran { ok: false, stdout: String::new(), stderr: String::new(), timed_out: true }))
        .unwrap_err();
    assert_eq!(error.code, "outcome_unknown");
}

#[test]
fn a_rejected_push_is_a_conflict_and_nothing_is_forced() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    let other = f.base.join("other");
    git(&f.base, &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]);
    std::fs::write(other.join("theirs.txt"), "theirs").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-q", "-m", "theirs"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let theirs = git(&other, &["rev-parse", "HEAD"]);

    std::fs::write(repo.join("mine.txt"), "mine").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "mine", "author": me() })).unwrap();
    let error = f.call("git.push", json!({ "repo": "app" })).unwrap_err();
    assert_eq!(error.code, "conflict", "{}", error.message);
    assert!(error.message.contains("pull"), "{}", error.message);
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]), theirs);

    // Fetch shows it; a fast-forward-only pull refuses the divergence.
    let fetched = f.call("git.fetch", json!({ "repo": "app" })).unwrap();
    assert_eq!((fetched["ahead"].clone(), fetched["behind"].clone()), (json!(1), json!(1)));
    assert_eq!(f.code("git.pull", json!({ "repo": "app" })), "conflict");
}

/// An HTTP Git remote that refuses every request, as GitHub does once the
/// workspace's token has expired and cannot be renewed.
fn refusing_remote() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"GitHub\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    });
    format!("http://127.0.0.1:{port}/octo/repo.git")
}

#[test]
fn expired_credentials_and_an_unreachable_remote_are_told_apart() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    std::fs::write(repo.join("x.txt"), "x").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "x", "author": me() })).unwrap();
    // No helper answers for this host (an empty value resets inherited ones).
    git(&repo, &["config", "credential.helper", ""]);

    git(&repo, &["remote", "set-url", "origin", &refusing_remote()]);
    let error = f.call("git.push", json!({ "repo": "app" })).unwrap_err();
    assert_eq!(error.code, "auth_failed", "{}", error.message);

    git(&repo, &["remote", "set-url", "origin", "http://127.0.0.1:9/octo/repo.git"]);
    let error = f.call("git.push", json!({ "repo": "app" })).unwrap_err();
    assert_eq!(error.code, "outcome_unknown", "{}", error.message);
}

#[test]
fn pull_requests_are_created_once_after_the_branch_is_pushed_into_the_chosen_base() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    f.call("git.checkout", json!({ "repo": "app", "branch": "feature/pr", "create": true })).unwrap();
    std::fs::write(repo.join("pr.txt"), "pr").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "pr", "author": me() })).unwrap();

    let create = json!({ "repo": "app", "title": "Add pr", "body": "Why", "base": "develop", "draft": true });
    assert_eq!(f.code("git.prCreate", create.clone()), "unpushed");
    f.call("git.push", json!({ "repo": "app" })).unwrap();
    let created = f.call("git.prCreate", create.clone()).unwrap();
    assert_eq!(created["created"], true);
    assert_eq!(created["pr"]["isDraft"], true);
    assert_eq!(created["pr"]["base"], "develop");
    assert_eq!(created["pr"]["head"], "feature/pr");

    // Repeating it (a lost answer, a second device) links the existing one.
    let repeat = f.call("git.prCreate", create).unwrap();
    assert_eq!((repeat["created"].clone(), repeat["existing"].clone()), (json!(false), json!(true)));
    assert_eq!(repeat["pr"]["number"], created["pr"]["number"]);
    assert_eq!(f.gh_calls().matches("\"create\"").count(), 1);

    let listed = f.call("git.prs", json!({ "repo": "app" })).unwrap();
    assert_eq!(listed["prs"].as_array().unwrap().len(), 1);
    let ready = f.call("git.prReady", json!({ "repo": "app", "number": 1 })).unwrap();
    assert_eq!(ready["pr"]["isDraft"], false);
}

#[test]
fn a_create_whose_answer_is_lost_finds_the_pull_request_it_made() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    f.call("git.checkout", json!({ "repo": "app", "branch": "feature/drop", "create": true })).unwrap();
    std::fs::write(repo.join("d.txt"), "d").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "d", "author": me() })).unwrap();
    f.call("git.push", json!({ "repo": "app" })).unwrap();
    f.fault("drop-after-create");
    let created = f.call("git.prCreate", json!({ "repo": "app", "title": "Drop" })).unwrap();
    assert_eq!(created["reconciled"], true);
    assert_eq!(created["pr"]["base"], "main", "the default branch is the default base");
    assert_eq!(f.gh_calls().matches("\"create\"").count(), 1);
}

#[test]
fn conflicts_and_expired_github_access_are_visible_in_pull_requests() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    f.call("git.checkout", json!({ "repo": "app", "branch": "feature/c", "create": true })).unwrap();
    std::fs::write(repo.join("c.txt"), "c").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "c", "author": me() })).unwrap();
    f.call("git.push", json!({ "repo": "app" })).unwrap();
    std::fs::write(f.state.join("mergeable"), "CONFLICTING").unwrap();
    std::fs::write(f.state.join("checks.json"), r#"[{"name":"ci","conclusion":"FAILURE"}]"#).unwrap();
    f.call("git.prCreate", json!({ "repo": "app", "title": "C" })).unwrap();
    let listed = f.call("git.prs", json!({ "repo": "app" })).unwrap();
    assert_eq!(listed["prs"][0]["mergeable"], "CONFLICTING");
    assert_eq!(listed["prs"][0]["checks"][0]["state"], "failure");
    assert_eq!(f.code("git.prMerge", json!({ "repo": "app", "number": 1, "method": "squash" })), "conflict");

    f.fault("auth-expired");
    assert_eq!(f.code("git.prs", json!({ "repo": "app" })), "auth_failed");
    assert_eq!(f.code("git.prCreate", json!({ "repo": "app", "title": "again" })), "auth_failed");
}

#[test]
fn disposition_facts_report_unpublished_work_per_repository() {
    let f = fixture();
    let remote = f.remote("origin");
    let app = f.clone(&remote, "app");
    let lib = f.clone(&remote, "lib");
    // app: a pushed branch with an open PR, one more commit, a dirty and an untracked file.
    f.call("git.checkout", json!({ "repo": "app", "branch": "feature/f", "create": true })).unwrap();
    std::fs::write(app.join("f.txt"), "f").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "f", "author": me() })).unwrap();
    f.call("git.push", json!({ "repo": "app" })).unwrap();
    f.call("git.prCreate", json!({ "repo": "app", "title": "F" })).unwrap();
    std::fs::write(app.join("f.txt"), "f2").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "f2", "author": me() })).unwrap();
    std::fs::write(app.join("README.md"), "changed").unwrap();
    std::fs::write(app.join("scratch.txt"), "s").unwrap();
    // lib: a local branch that was never pushed.
    f.call("git.checkout", json!({ "repo": "lib", "branch": "local-only", "create": true })).unwrap();
    std::fs::write(lib.join("l.txt"), "l").unwrap();
    f.call("git.commit", json!({ "repo": "lib", "message": "l", "author": me() })).unwrap();

    let facts = f.git.disposition_repositories();
    assert_eq!(
        facts[0],
        json!({
            "path": "app", "branch": "feature/f", "dirtyFiles": 2, "untrackedFiles": 1,
            "unpushedCommits": 1, "hasUpstream": true, "localOnlyCommits": 1,
            "openPullRequests": [{ "number": 1, "url": "https://github.test/octo/repo/pull/1", "state": "open" }],
        })
    );
    assert_eq!(facts[1]["path"], "lib");
    assert_eq!(facts[1]["hasUpstream"], false);
    assert_eq!(facts[1]["unpushedCommits"], Value::Null);
    assert_eq!(facts[1]["localOnlyCommits"], 1);
    assert_eq!(facts[1]["openPullRequests"], json!([]));

    // GitHub unreachable: the facts still come, without pull requests.
    f.fault("offline");
    let facts = f.git.disposition_repositories();
    assert_eq!(facts[0]["openPullRequests"], Value::Null);
    assert_eq!(facts[0]["dirtyFiles"], 2);
}

#[test]
fn failures_are_classified_for_the_client() {
    assert_eq!(classify("fatal: could not read Username for 'https://github.com': terminal prompts disabled", false), Failure::Auth);
    assert_eq!(classify("remote: Invalid username or password.\nfatal: Authentication failed", false), Failure::Auth);
    assert_eq!(classify("terminalx: the server no longer accepts this workspace's runtime credential; restart the workspace", false), Failure::Auth);
    assert_eq!(classify(" ! [rejected]        main -> main (fetch first)", false), Failure::Conflict);
    assert_eq!(classify("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", false), Failure::Network);
    assert_eq!(classify("", true), Failure::Network);
    assert_eq!(classify("fatal: something else", false), Failure::Other);
    // GitHub's 404 for a repository the token cannot see is certain, not a network fault.
    assert_eq!(classify("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404", false), Failure::Auth);
    assert_eq!(classify("error: pathspec 'src/conflict.rs' did not match any file(s) known to git", false), Failure::Other);
    assert_eq!(classify("CONFLICT (content): Merge conflict in a.txt", false), Failure::Conflict);
    for good in ["feature/x-1.2", "fix#123", "user+topic", "ümlaut/zweig"] {
        assert!(valid_ref_name(good), "{good}");
    }
    for bad in ["-x", "a..b", "a b", "a/", "/a", "a.lock", "a//b", "", "a~1", "a:b", "a^", "x@{1}", ".hidden", "a/.b", "tab\tname"] {
        assert!(!valid_ref_name(bad), "{bad}");
    }
    assert_eq!(display_remote("https://x-access-token:secret@github.com/o/r.git"), "https://github.com/o/r.git");
}

#[test]
fn a_root_inside_a_checkout_is_that_repository() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "mono");
    std::fs::create_dir_all(repo.join("packages/web")).unwrap();
    let inner = WorkspaceGit::new(repo.join("packages/web"), Arc::new(WorkspaceFiles::new(repo.join("packages/web"))));
    assert_eq!(inner.repositories().0, ["."]);
    assert_eq!(inner.handle("git.status", &json!({})).unwrap().unwrap()["branch"], "main");
}

#[test]
fn a_forks_pull_request_from_a_branch_of_the_same_name_is_not_this_branchs() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    f.call("git.checkout", json!({ "repo": "app", "branch": "fix-typo", "create": true })).unwrap();
    std::fs::write(repo.join("t.txt"), "t").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "t", "author": me() })).unwrap();
    f.call("git.push", json!({ "repo": "app" })).unwrap();
    let fork = json!({
        "number": 1, "title": "Someone else's", "body": "", "url": "https://github.test/octo/repo/pull/1", "state": "OPEN",
        "isDraft": false, "baseRefName": "main", "headRefName": "fix-typo", "additions": 1, "deletions": 0,
        "mergeable": "MERGEABLE", "reviewDecision": "", "statusCheckRollup": [], "author": { "login": "stranger" },
        "isCrossRepository": true,
    });
    std::fs::write(f.state.join("pr-1.json"), fork.to_string()).unwrap();
    assert_eq!(f.call("git.prs", json!({ "repo": "app" })).unwrap()["prs"], json!([]));
    assert_eq!(f.git.disposition_repositories()[0]["openPullRequests"], json!([]));
    let created = f.call("git.prCreate", json!({ "repo": "app", "title": "Mine" })).unwrap();
    assert_eq!((created["created"].clone(), created["pr"]["number"].clone()), (json!(true), json!(2)));
}
