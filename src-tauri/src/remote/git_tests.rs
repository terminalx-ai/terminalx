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
fn branch_diff_size_uses_the_selected_base_without_persisting_worktree_objects() {
    let f = fixture();
    let origin = f.remote("origin");
    let project = f.clone(&origin, "app");
    git(&project, &["checkout", "-qb", "release/2.x"]);
    std::fs::write(project.join("release.txt"), "release only\n").unwrap();
    std::fs::write(project.join(".gitattributes"), "draft.txt filter=test\n").unwrap();
    std::fs::write(project.join(".gitignore"), "ignored.txt\n").unwrap();
    git(&project, &["add", "."]);
    git(&project, &["commit", "-qm", "release"]);
    let checkout = project.join("worktrees/topic");
    git(&project, &["worktree", "add", "-qb", "topic", checkout.to_str().unwrap()]);
    let runtime = WorkspaceGit::for_project(project.clone(), Arc::new(WorkspaceFiles::new(project.clone())));
    let diff_size = || {
        let params = json!({ "repo": "worktrees/topic", "base": "release/2.x" });
        runtime.handle("git.branchDiffSize", &params).unwrap().unwrap()
    };
    let branch_base = || {
        let params = json!({ "repo": "worktrees/topic", "base": "release/2.x" });
        runtime.handle("git.branchBase", &params).unwrap().unwrap()
    };
    let base = git(&checkout, &["rev-parse", "HEAD"]);
    assert_eq!(branch_base(), json!({ "aheadOfBase": 0, "head": base }));
    assert_eq!(diff_size(), json!({ "additions": 0, "deletions": 0, "head": base }));
    std::fs::write(checkout.join("committed.txt"), "committed\n").unwrap();
    git(&checkout, &["add", "committed.txt"]);
    git(&checkout, &["commit", "-qm", "topic"]);
    std::fs::write(checkout.join("staged.txt"), "staged\n").unwrap();
    git(&checkout, &["add", "staged.txt"]);
    std::fs::write(checkout.join("README.md"), "edited\n").unwrap();
    std::fs::write(checkout.join("ignored.txt"), "not counted\n").unwrap();
    std::fs::write(checkout.join("draft.txt"), "one\n").unwrap();
    git(&project, &["config", "filter.test.clean", "touch filter-ran && cat"]);
    git(&project, &["config", "filter.test.required", "true"]);
    let index = git(&checkout, &["ls-files", "--stage"]);
    let objects = git(&project, &["count-objects", "-v"]);
    let head = git(&checkout, &["rev-parse", "HEAD"]);

    assert_eq!(branch_base(), json!({ "aheadOfBase": 1, "head": head }));
    assert_eq!(diff_size(), json!({ "additions": 4, "deletions": 1, "head": head }));
    std::fs::write(checkout.join("draft.txt"), "one\ntwo\n").unwrap();
    assert_eq!(diff_size(), json!({ "additions": 5, "deletions": 1, "head": head }));
    std::fs::remove_file(checkout.join("draft.txt")).unwrap();
    assert_eq!(diff_size(), json!({ "additions": 3, "deletions": 1, "head": head }));
    assert_eq!(git(&project, &["count-objects", "-v"]), objects);
    assert_eq!(git(&checkout, &["ls-files", "--stage"]), index);
    assert!(!checkout.join("filter-ran").exists());
}

#[test]
fn branch_diff_size_refuses_to_start_after_its_deadline() {
    assert_eq!(branch_diff_size(Path::new("."), "main", Instant::now()).unwrap_err().code, "timeout");
}

#[test]
fn commit_and_push_refuse_a_changed_checkout_or_head() {
    let f = fixture();
    let origin = f.remote("origin");
    let checkout = f.clone(&origin, "app");
    let head = git(&checkout, &["rev-parse", "HEAD"]);
    git(&checkout, &["checkout", "-qb", "other"]);
    std::fs::write(checkout.join("draft"), "work\n").unwrap();
    let params = json!({
        "repo": "app", "message": "work", "author": me(),
        "expectedBranch": "main", "expectedHead": head
    });
    assert_eq!(f.code("git.commitForPush", params.clone()), "conflict");
    assert_eq!(git(&checkout, &["status", "--porcelain"]), "?? draft");
    git(&checkout, &["checkout", "-q", "main"]);
    let commit = f.call("git.commitForPush", params.clone()).unwrap();
    assert_eq!(commit["branch"], "main");
    assert_ne!(commit["commit"], head);
    assert_eq!(f.code("git.commitForPush", params), "conflict");
    let push = |head: Value| json!({ "repo": "app", "branch": "main", "head": head });
    assert_eq!(f.code("git.pushHead", push(json!(head))), "conflict");
    assert_eq!(f.code("git.pushHead", json!({ "repo": "app", "branch": "main" })), "invalid_params");
    assert_eq!(f.call("git.pushHead", push(commit["commit"].clone())).unwrap()["head"], commit["commit"]);
    assert_eq!(git(&origin, &["rev-parse", "refs/heads/main"]), commit["commit"]);
    assert_eq!(git(&checkout, &["status", "--porcelain"]), "");
}

#[cfg(unix)]
#[test]
fn guarded_commit_hooks_see_the_named_branch_and_branch_specific_config() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture();
    let origin = f.remote("origin");
    let checkout = f.clone(&origin, "app");
    let head = git(&checkout, &["rev-parse", "HEAD"]);
    git(&checkout, &["config", "includeIf.onbranch:main.path", "branch.conf"]);
    std::fs::write(checkout.join(".git/branch.conf"), "[user]\n\tsigningKey = branch-specific\n").unwrap();
    let hook = checkout.join(".git/hooks/pre-commit");
    std::fs::write(&hook, concat!(
        "#!/bin/sh\nset -eu\n",
        "test \"$(git branch --show-current)\" = main\n",
        "test \"$(git config --show-scope --get user.signingKey)\" = \"$(printf 'local\\tbranch-specific')\"\n",
        "test \"$(git rev-parse refs/remotes/origin/main)\" = \"$(git rev-parse HEAD)\"\n",
    )).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(checkout.join("draft"), "work\n").unwrap();
    let params = json!({ "repo": "app", "message": "work", "author": me(), "expectedBranch": "main", "expectedHead": head });
    let result = f.call("git.commitForPush", params).unwrap();
    assert_eq!(result["branch"], "main");
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), result["commit"]);
    assert_eq!(git(&checkout, &["status", "--porcelain"]), "");
}

#[cfg(unix)]
#[test]
fn guarded_commit_requires_checkout_path_signing_in_a_linked_worktree() {
    use std::os::unix::fs::PermissionsExt;

    for condition in ["gitdir:./worktrees/topic", "gitdir/i:./WORKTREES/TOPIC"] {
        let f = fixture();
        let origin = f.remote("origin");
        let project = f.clone(&origin, "app");
        let checkout = project.join("worktrees/topic");
        git(&project, &["worktree", "add", "-qb", "topic", checkout.to_str().unwrap()]);
        let runtime = WorkspaceGit::for_project(project.clone(), Arc::new(WorkspaceFiles::new(project.clone())));
        let head = git(&checkout, &["rev-parse", "HEAD"]);

        git(&project, &["config", &format!("includeIf.{condition}.path"), "signing.conf"]);
        std::fs::write(project.join(".git/signing.conf"), "[commit]\n\tgpgSign = true\n[gpg]\n\tformat = openpgp\n").unwrap();
        git(&project, &["config", "extensions.worktreeConfig", "true"]);
        git(&checkout, &["config", "--worktree", "user.signingKey", "topic-key"]);
        git(&checkout, &["config", "--worktree", "gpg.openpgp.program", "./fail-signing"]);
        let signing = git_command(&checkout).args(["config", "--show-scope", "--get", "commit.gpgSign"]).output().unwrap();
        assert!(signing.status.success(), "{condition}");
        assert_eq!(signing.stdout, b"local\ttrue\n", "{condition}");

        let hook = project.join(".git/hooks/pre-commit");
        std::fs::write(&hook, concat!(
            "#!/bin/sh\nset -eu\n",
            "test \"$(git config --show-scope --get commit.gpgSign)\" = 'local\ttrue'\n",
            "test \"$(git config --show-scope --get user.signingKey)\" = 'worktree\ttopic-key'\n",
        )).unwrap();
        let signer = checkout.join("fail-signing");
        std::fs::write(&signer, "#!/bin/sh\nprintf '%s\\n' \"$@\" > signing-attempt\nexit 1\n").unwrap();
        for executable in [&hook, &signer] {
            std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        std::fs::write(checkout.join("staged"), "staged\n").unwrap();
        git(&checkout, &["add", "staged"]);
        let index = git(&checkout, &["ls-files", "--stage"]);
        let params = json!({
            "repo": "worktrees/topic", "message": "work", "author": me(),
            "expectedBranch": "topic", "expectedHead": head
        });
        let error = runtime.handle("git.commitForPush", &params).unwrap().unwrap_err();
        assert_eq!(error.code, "git_failed", "{condition}: {error:?}");
        let signing = std::fs::read_to_string(checkout.join("signing-attempt")).expect("Git invoked the checkout's signer");
        assert!(signing.lines().any(|arg| arg == "topic-key"), "{condition}: {signing}");
        assert_eq!(git(&checkout, &["rev-parse", "refs/heads/topic"]), head);
        assert_eq!(git(&project, &["rev-parse", "refs/heads/main"]), head);
        assert_eq!(git(&checkout, &["ls-files", "--stage"]), index);
        assert_eq!(git(&checkout, &["symbolic-ref", "HEAD"]), "refs/heads/topic");
        assert!(!project.join(".git/worktrees/topic/index.lock").exists());
    }
}

#[test]
fn guarded_commit_config_keeps_checkout_only_global_entries_conditional() {
    let f = fixture();
    let origin = f.remote("origin");
    let checkout = f.clone(&origin, "app");
    let global = f.base.join("global.conf");
    std::fs::write(&global, concat!(
        "[terminalx]\n\tvalue = before\n",
        "[includeIf \"gitdir:./workspace/app/.git\"]\n\tpath = matching.conf\n",
        "[terminalx]\n\tvalue = after\n",
    )).unwrap();
    std::fs::write(f.base.join("matching.conf"), "[terminalx]\n\tvalue = included\n[safe]\n\tdirectory = *\n").unwrap();
    let scratch = f.base.join("scratch");
    let private = scratch.join("repo");
    std::fs::create_dir_all(&private).unwrap();
    git(&private, &["init", "-q", "--bare"]);
    let checkout_git = || {
        let mut command = git_command(&checkout);
        command.env("GIT_CONFIG_GLOBAL", &global).env("GIT_CONFIG_NOSYSTEM", "1")
            .env_remove("GIT_CONFIG").env_remove("GIT_CONFIG_COUNT").env_remove("GIT_CONFIG_PARAMETERS");
        command
    };
    snapshot_commit_config(checkout_git, &scratch, "sha1", false).unwrap();

    let read_values = |git_dir: &Path, key: &str| {
        let mut command = checkout_git();
        command.env("GIT_CONFIG_GLOBAL", scratch.join("config.global"))
            .env("GIT_DIR", git_dir).args(["config", "--show-scope", "--get-all", key]);
        command.output().unwrap()
    };
    assert_eq!(read_values(&private, "terminalx.value").stdout, b"global\tbefore\nglobal\tincluded\nglobal\tafter\n");
    let outside = scratch.join("no-repository");
    assert_eq!(read_values(&outside, "terminalx.value").stdout, b"global\tbefore\nglobal\tafter\n");
    assert_eq!(read_values(&outside, "safe.directory").status.code(), Some(1));
}

#[cfg(unix)]
#[test]
fn guarded_commit_preserves_local_and_linked_worktree_config_scopes() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture();
    let origin = f.remote("origin");
    let project = f.clone(&origin, "app");
    let checkout = project.join("worktrees/topic");
    git(&project, &["worktree", "add", "-qb", "topic", checkout.to_str().unwrap()]);
    let other = f.clone(&origin, "other");
    git(&other, &["config", "--local", "core.hooksPath", ".git/destination-hooks"]);
    let destination_hooks = other.join(".git/destination-hooks");
    std::fs::create_dir(&destination_hooks).unwrap();
    let destination_hook = destination_hooks.join("commit-msg");
    std::fs::write(&destination_hook, "#!/bin/sh\nprintf 'destination hook ran\\n' > hook-ran\n").unwrap();
    std::fs::set_permissions(&destination_hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let runtime = WorkspaceGit::for_project(project.clone(), Arc::new(WorkspaceFiles::new(project.clone())));
    let head = git(&checkout, &["rev-parse", "HEAD"]);
    git(&project, &["config", "--local", "extensions.worktreeConfig", "true"]);
    git(&project, &["config", "--local", "terminalx.scopeTest", "from-local"]);
    git(&checkout, &["config", "--worktree", "terminalx.scopeTest", "from-worktree"]);
    git(&project, &["config", "--local", "commit.cleanup", "verbatim"]);
    git(&checkout, &["config", "--worktree", "commit.cleanup", "strip"]);

    let hooks = f.root.join("configured hooks");
    std::fs::create_dir(&hooks).unwrap();
    git(&checkout, &["config", "--worktree", "core.hooksPath", "../../../configured hooks"]);
    let hook = hooks.join("pre-commit");
    std::fs::write(&hook, concat!(
        "#!/bin/sh\nset -eu\n",
        "test \"$(git config --show-scope --get-all terminalx.scopeTest)\" = ",
        "\"$(printf 'local\\tfrom-local\\nworktree\\tfrom-worktree')\"\n",
        "test \"$(git config --show-scope --get core.hooksPath)\" = ",
        "\"$(printf 'worktree\\t../../../configured hooks')\"\n",
        // Move to another checkout without clearing command-scope configuration.
        "unset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY\n",
        "git -C ../../../other rev-parse --is-inside-work-tree >/dev/null\n",
        "status=0\n",
        "git -C ../../../other config --get-all terminalx.scopeTest || status=$?\n",
        "test \"$status\" = 1\n",
        "git -C ../../../other -c commit.gpgsign=false commit --allow-empty -qm 'check destination hook'\n",
        "printf 'hook ran\\n' > hook-ran\n",
    )).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    std::fs::write(checkout.join("draft"), "work\n").unwrap();
    let params = json!({
        "repo": "worktrees/topic", "message": "work\n\n# drop this line", "author": me(),
        "expectedBranch": "topic", "expectedHead": head,
    });
    let result = runtime.handle("git.commitForPush", &params).unwrap().unwrap();
    assert_eq!(result["branch"], "topic");
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), result["commit"]);
    assert_eq!(git(&checkout, &["rev-parse", "HEAD^"]), head);
    assert_eq!(git(&checkout, &["log", "-1", "--format=%B"]), "work");
    assert_eq!(std::fs::read_to_string(checkout.join("hook-ran")).unwrap(), "hook ran\n");
    assert_eq!(std::fs::read_to_string(other.join("hook-ran")).unwrap(), "destination hook ran\n");
}

#[cfg(unix)]
#[test]
fn guarded_commit_uses_hooks_selected_by_the_real_git_directory() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture();
    let origin = f.remote("origin");
    let checkout = f.clone(&origin, "app");
    let head = git(&checkout, &["rev-parse", "HEAD"]);
    git(&checkout, &["config", "--local", "extensions.worktreeConfig", "false"]);
    git(&checkout, &["config", "--local", "core.hooksPath", ".git/default-hooks"]);
    git(&checkout, &["config", "--local", "includeIf.gitdir:**/app/.git.path", "checkout.conf"]);
    std::fs::write(checkout.join(".git/checkout.conf"), "[core]\n\thooksPath = .git/checkout-hooks\n").unwrap();
    assert_eq!(git(&checkout, &["config", "--get", "core.hooksPath"]), ".git/checkout-hooks");

    let hooks = checkout.join(".git/checkout-hooks");
    std::fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("pre-commit");
    std::fs::write(&hook, concat!(
        "#!/bin/sh\nset -eu\n",
        "test \"$(git config --show-scope --get core.hooksPath | cut -f1)\" = local\n",
        "printf 'checkout hook ran\\n' > hook-ran\n",
    )).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    std::fs::write(checkout.join("draft"), "work\n").unwrap();
    let params = json!({ "repo": "app", "message": "work", "author": me(), "expectedBranch": "main", "expectedHead": head });
    let result = f.call("git.commitForPush", params).unwrap();
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), result["commit"]);
    assert_eq!(std::fs::read_to_string(checkout.join("hook-ran")).unwrap(), "checkout hook ran\n");
}

#[cfg(unix)]
#[test]
fn switching_the_real_head_during_commit_preparation_updates_neither_branch() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture();
    let origin = f.remote("origin");
    let checkout = f.clone(&origin, "app");
    let head = git(&checkout, &["rev-parse", "HEAD"]);
    git(&checkout, &["branch", "other"]);
    std::fs::write(checkout.join("draft"), "work\n").unwrap();
    let hook = checkout.join(".git/hooks/pre-commit");
    std::fs::write(&hook, concat!(
        "#!/bin/sh\n",
        "env -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git symbolic-ref HEAD refs/heads/other\n",
    )).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let params = json!({ "repo": "app", "message": "work", "author": me(), "expectedBranch": "main", "expectedHead": head });
    assert_eq!(f.code("git.commitForPush", params), "conflict");
    assert_eq!(git(&checkout, &["branch", "--show-current"]), "other");
    assert_eq!(git(&checkout, &["rev-parse", "refs/heads/main"]), head);
    assert_eq!(git(&checkout, &["rev-parse", "refs/heads/other"]), head);
    assert_eq!(git(&checkout, &["status", "--porcelain"]), "?? draft");
    assert!(!checkout.join(".git/index.lock").exists());
}

#[test]
fn machine_base_lookup_reports_a_deleted_ref_separately_from_other_errors() {
    let f = fixture();
    let origin = f.remote("origin");
    f.clone(&origin, "app");
    assert_eq!(f.code("git.branchBase", json!({ "repo": "app", "base": "deleted/release" })), "base_not_found");
    assert_eq!(f.call("git.branchBase", json!({ "repo": "app", "base": "main" })).unwrap()["aheadOfBase"], 0);
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
    assert_eq!(pair, json!({ "before": "hello\n", "after": "hello\nworld\n", "beforeSize": 6, "afterSize": 12 }));

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
fn review_options_and_media_reads_use_the_selected_repository() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    std::fs::write(repo.join("README.md"), "  hello \n").unwrap();
    let changes = f.call("git.workingChanges", json!({ "repo": "app", "hideWhitespace": true })).unwrap();
    assert_eq!(changes["files"][0]["additions"], 0);
    assert_eq!(changes["files"][0]["deletions"], 0);
    std::fs::write(repo.join("image.png"), b"\0\xffPNG").unwrap();
    let live = f.call("git.mediaContent", json!({ "repo": "app", "path": "image.png" })).unwrap();
    assert_eq!(live, json!({ "data": "AP9QTkc=", "mime": "image/png" }));
    let base = crate::git::snapshot_tree(&repo).unwrap();
    std::fs::write(repo.join("image.png"), b"updated").unwrap();
    assert_eq!(f.call("git.mediaContent", json!({ "repo": "app", "path": "image.png", "tree": base })).unwrap(), live);
    assert!(f.call("git.mediaContent", json!({ "repo": "app", "path": "missing.pdf", "tree": base })).unwrap().is_null());
    assert_eq!(f.code("git.mediaContent", json!({ "repo": "app", "path": "../escape.png" })), "path_forbidden");
    std::fs::write(repo.join("large.pdf"), vec![0; 512 * 1024 + 1]).unwrap();
    assert!(f.call("git.mediaContent", json!({ "repo": "app", "path": "large.pdf" })).is_err());
    #[cfg(unix)] {
        std::fs::write(f.base.join("secret.png"), "secret").unwrap();
        std::os::unix::fs::symlink(f.base.join("secret.png"), repo.join("leak.png")).unwrap();
        assert_eq!(f.code("git.mediaContent", json!({ "repo": "app", "path": "leak.png" })), "path_forbidden");
    }
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
        .push_with(&json!({ "repo": "app" }), |repo, branch, head| {
            git(&repo.dir, &["push", "-q", "origin", &format!("{head}:refs/heads/{branch}")]);
            Ok(Ran { ok: false, stdout: String::new(), stderr: "fatal: the remote end hung up unexpectedly".into(), timed_out: false })
        })
        .unwrap();
    assert_eq!((answer["pushed"].clone(), answer["reconciled"].clone()), (json!(true), json!(true)));

    // One that did not land is `outcome_unknown`, and says a retry checks first.
    std::fs::write(repo.join("y.txt"), "y").unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "y", "author": me() })).unwrap();
    let error = f
        .git
        .push_with(&json!({ "repo": "app" }), |_, _, _| Ok(Ran { ok: false, stdout: String::new(), stderr: String::new(), timed_out: true }))
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
    // An associated identity is readable after switching branches, even if a
    // branch listing would omit it (or its old branch has been removed).
    f.call("git.checkout", json!({ "repo": "app", "branch": "main" })).unwrap();
    let retained = f.call("git.prs", json!({ "repo": "app", "branch": "deleted-old-branch", "number": 1 })).unwrap();
    assert_eq!(retained["prs"][0]["number"], 1);
    assert_eq!(retained["prs"][0]["head"], "feature/pr");
    assert!(f.gh_calls().contains("\"view\", \"1\""));
    assert_eq!(f.code("git.prs", json!({ "repo": "app", "number": 0 })), "invalid_params");
}

#[test]
fn machine_pr_creation_records_the_native_session_association() {
    let _home = crate::store::temp_home();
    let mut f = fixture();
    let remote = f.remote("origin");
    f.clone(&remote, ".");
    f.git.project = true;
    let checkout = f.base.join("feature-worktree");
    let locator = checkout.to_str().unwrap();
    git(&f.root, &["worktree", "add", "-qb", "feature/pr", locator]);
    f.call("git.push", json!({ "repo": locator })).unwrap();
    // Git uses a local mirror while gh selects the Enterprise remote.
    git(&f.root, &["remote", "add", "enterprise", "git@work:Octo/Repo.git"]);
    std::fs::write(f.state.join("repo-url"), "https://github.test/Octo/Repo").unwrap();
    let conversation = include_str!("../fixtures/github_pr_conversation.json")
        .replace("https://github.com/acme/widgets/pull/799", "https://github.test/octo/repo/pull/1")
        .replace("https://github.com/acme/widgets/", "https://github.test/octo/repo/");
    std::fs::write(f.state.join("conversation.json"), conversation).unwrap();
    let session = |id: &str, project: &Path| serde_json::from_value::<crate::store::index::SessionEntry>(json!({
        "id": id, "projectPath": project, "cwd": checkout, "title": "fixture", "created": "", "modified": ""
    })).unwrap();
    crate::store::index::save(&[session("native", &f.root), session("root-association", &f.root), session("outside", &f.base)]).unwrap();
    let create = |id: &str| json!({ "repo": locator, "title": "Add pr", "base": "main", "draft": true, "sessionId": id });
    assert_eq!(f.code("git.prCreate", create("outside")), "not_found");
    assert!(!f.gh_calls().contains("\"create\""));

    let created = f.call("git.prCreate", create("native")).unwrap();
    assert_eq!(created["sessionAssociated"], true);
    let repeat = f.call("git.prCreate", create("native")).unwrap();
    assert_eq!(repeat["existing"], true);
    assert_eq!(repeat["sessionAssociated"], true);
    assert_eq!(f.gh_calls().matches("\"create\"").count(), 1);
    let read = || f.call("git.prAssociations", json!({ "sessionId": "native" })).unwrap();
    let rows = read();
    assert_eq!(rows["associations"].as_array().unwrap().len(), 1);
    let association = &rows["associations"][0];
    assert_eq!(association["url"], "https://github.test/octo/repo/pull/1");
    assert_eq!(association["url"], created["pr"]["url"]);
    assert_eq!(association["repo"], locator);
    assert_eq!(association["linked"], false);
    let legacy = f.git.handle_negotiated("git.prAssociations", &json!({ "sessionId": "native" }), false).unwrap().unwrap();
    assert_eq!(legacy["associations"][0]["url"], association["url"]);
    assert!(legacy["associations"][0]["repo"].is_null());
    let unsupported = f.git.handle_negotiated("git.prReady", &json!({ "repo": locator, "url": association["url"] }), false).unwrap().unwrap_err();
    assert_eq!(unsupported.code, "capability_not_granted");

    let conversation = f.call("git.prConversation", json!({ "repo": association["repo"], "url": association["url"] })).unwrap();
    assert_eq!(conversation["activity"].as_array().unwrap().len(), 11);
    assert!(f.gh_calls().contains("\"graphql\", \"--hostname\", \"github.test\""));
    // A recovered record can name the root, where gh defaults to another
    // repository with the same PR number despite a matching origin.
    let url = association["url"].as_str().unwrap();
    crate::pr_associations::record_local("root-association", &f.root, url, "feature/pr").unwrap();
    git(&f.root, &["remote", "set-url", "origin", "https://github.test/octo/repo.git"]);
    let alternate = f.base.join("alternate-github");
    std::fs::create_dir(&alternate).unwrap();
    let alternate_url = "https://github.test/other/repo/pull/1";
    let mut alternate_pr: Value = serde_json::from_slice(&std::fs::read(f.state.join("pr-1.json")).unwrap()).unwrap();
    alternate_pr["url"] = json!(alternate_url);
    std::fs::write(alternate.join("repo-url"), "https://github.test/other/repo").unwrap();
    std::fs::write(alternate.join("pr-1.json"), alternate_pr.to_string()).unwrap();
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/remote-runtime/fake-gh");
    std::fs::write(f.base.join("gh"), format!(
        "#!/bin/sh\nstate='{}'\nif [ \"$(pwd -P)\" = '{}' ] && [ \"$3\" != '{}' ]; then state='{}'; fi\nFAKE_GH_STATE=\"$state\" exec '{}' \"$@\"\n",
        f.state.display(), f.root.display(), url, alternate.display(), fake.display(),
    )).unwrap();
    let root_rows = f.call("git.prAssociations", json!({ "sessionId": "root-association" })).unwrap();
    let resolved = &root_rows["associations"][0]["repo"];
    assert_eq!(resolved, locator);
    let numeric = f.call("git.prs", json!({ "repo": ".", "number": 1 })).unwrap();
    assert_eq!(numeric["prs"][0]["url"], alternate_url);
    let pinned = f.call("git.prs", json!({ "repo": resolved, "number": 1, "url": url })).unwrap();
    assert_eq!(pinned["prs"][0]["url"], url);
    for method in ["git.prReady", "git.prMerge"] {
        assert_eq!(f.code(method, json!({ "repo": ".", "url": url })), "invalid_params");
        assert_eq!(f.code(method, json!({ "repo": resolved, "url": "https://github.test/unrelated/repo/pull/1" })), "invalid_params");
        assert_eq!(f.code(method, json!({ "repo": resolved, "number": 2, "url": url })), "invalid_params");
        for host in ["github.test:8443", "www.github.test"] {
            let error = f.call(method, json!({ "repo": resolved, "url": format!("https://{host}/octo/repo/pull/1") })).unwrap_err();
            assert_eq!(error.code, "invalid_params");
            assert!(error.message.contains("hostname exactly"));
        }
    }
    let ready = f.call("git.prReady", json!({ "repo": resolved, "url": url })).unwrap();
    assert_eq!(ready["pr"]["url"], url);
    assert_eq!(ready["pr"]["isDraft"], false);
    let merged = f.call("git.prMerge", json!({ "repo": resolved, "url": url, "method": "squash" })).unwrap();
    assert_eq!(merged["pr"]["url"], url);
    assert_eq!(merged["pr"]["state"], "MERGED");
    let calls = f.gh_calls();
    assert!(calls.lines().any(|line| line.contains("markPullRequestReadyForReview(") && line.contains("\"id=PR_fixture_1\"") && !line.contains(url)));
    assert!(calls.lines().any(|line| line.contains("mergePullRequest(") && line.contains("\"id=PR_fixture_1\"") && !line.contains(url)));
    let untouched: Value = serde_json::from_slice(&std::fs::read(alternate.join("pr-1.json")).unwrap()).unwrap();
    assert_eq!(untouched, alternate_pr);

    // The PR command can follow a rename even if repo view still returns the
    // old URL. No write may run after a different PR URL comes back.
    let mut relocated = alternate_pr;
    relocated["url"] = json!("https://github.test/new-owner/repo/pull/1");
    std::fs::write(f.state.join("pr-1.json"), relocated.to_string()).unwrap();
    std::fs::write(f.state.join("redirect-from"), url).unwrap();
    let calls_before = f.gh_calls();
    for method in ["git.prReady", "git.prMerge", "git.prConversationAction"] {
        let error = f.call(method, json!({ "repo": resolved, "url": url, "action": {
            "kind": "edit", "title": "New title", "body": "", "expectedTitle": "Add pr", "expectedBody": ""
        } })).unwrap_err();
        assert!(error.message.contains("different pull request"), "{error:?}");
    }
    let calls = f.gh_calls();
    for verb in ["ready", "merge", "edit"] {
        assert!(!calls[calls_before.len()..].contains(&format!("[\"pr\", \"{verb}\"")));
    }
    assert!(!calls[calls_before.len()..].contains("mutation("));

    git(&f.root, &["worktree", "remove", locator]);
    git(&f.root, &["remote", "set-url", "origin", "https://github.com/octo/repo.git"]);
    let unavailable = read();
    assert_eq!(unavailable["associations"][0]["url"], association["url"]);
    assert!(unavailable["associations"][0]["repo"].is_null());
}

#[test]
fn legacy_machine_pull_request_locators_bind_numeric_actions_to_the_public_github_pr() {
    let _home = crate::store::temp_home();
    let mut f = fixture();
    let remote = f.remote("origin");
    f.clone(&remote, ".");
    f.git.project = true;
    let session = serde_json::from_value(json!({
        "id": "legacy", "projectPath": f.root, "cwd": f.root, "title": "fixture", "created": "", "modified": ""
    })).unwrap();
    crate::store::index::save(&[session]).unwrap();
    let url = "https://github.com/octo/repo/pull/7";
    crate::pr_associations::record_local("legacy", &f.root, url, "feature").unwrap();
    std::fs::write(f.state.join("repo-url"), "https://github.com/octo/repo").unwrap();
    std::fs::write(f.state.join("pr-7.json"), json!({
        "id": "PR_public", "number": 7, "url": url, "state": "OPEN", "isDraft": true, "headRefName": "feature"
    }).to_string()).unwrap();
    let conversation = include_str!("../fixtures/github_pr_conversation.json")
        .replace("https://github.com/acme/widgets/pull/799", url);
    std::fs::write(f.state.join("conversation.json"), conversation).unwrap();
    let call = |method, params| f.git.handle_negotiated(method, &params, false).unwrap();
    let rows = call("git.prAssociations", json!({ "sessionId": "legacy" })).unwrap();
    let repo = &rows["associations"][0]["repo"];
    assert!(repo.as_str().unwrap().starts_with(LEGACY_PR_REPO_PREFIX));
    assert_eq!(call("git.prs", json!({ "repo": repo, "number": 7 })).unwrap()["prs"][0]["url"], url);
    assert_eq!(call("git.prConversation", json!({ "repo": repo, "url": url })).unwrap()["url"], url);
    assert_eq!(call("git.prReady", json!({ "repo": repo, "number": 7 })).unwrap()["pr"]["isDraft"], false);
    assert_eq!(call("git.prMerge", json!({ "repo": repo, "number": 8 })).unwrap_err().code, "invalid_params");
    assert_eq!(call("git.prMerge", json!({ "repo": repo, "number": 7, "method": "squash" })).unwrap()["pr"]["state"], "MERGED");
    std::fs::write(f.state.join("repo-url"), "https://github.com/another/repo").unwrap();
    let before = f.gh_calls();
    assert_eq!(call("git.prMerge", json!({ "repo": repo, "number": 7 })).unwrap_err().code, "invalid_params");
    assert!(!f.gh_calls()[before.len()..].contains("mutation("));
}

#[test]
fn recorded_pull_request_checkouts_are_probed_before_any_fallback_scan() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let remote = f.remote("origin");
    let fallback = f.clone(&remote, "a-fallback");
    let recorded = f.clone(&remote, "z-recorded");
    git(&fallback, &["config", "terminalx.testGithubRepoUrl", "https://github.com/octo/unrelated"]);
    git(&recorded, &["config", "terminalx.testGithubRepoUrl", "https://github.com/octo/valid"]);
    let session = serde_json::from_value(json!({
        "id": "recorded", "projectPath": f.root, "cwd": recorded, "title": "fixture", "created": "", "modified": ""
    })).unwrap();
    crate::store::index::save(&[session]).unwrap();
    crate::pr_associations::record_local("recorded", &f.base, "https://github.com/octo/stale/pull/1", "old").unwrap();
    crate::pr_associations::record_local("recorded", &recorded, "https://github.com/octo/valid/pull/1", "new").unwrap();
    let shim = f.base.join("gh");
    let script = std::fs::read_to_string(&shim).unwrap();
    let log = f.state.join("checkouts");
    std::fs::write(&shim, script.replacen("#!/bin/sh\n", &format!("#!/bin/sh\npwd -P >> '{}'\n", log.display()), 1)).unwrap();
    let rows = f.call("git.prAssociations", json!({ "sessionId": "recorded" })).unwrap();
    assert!(rows["associations"][0]["repo"].is_null());
    assert_eq!(rows["associations"][1]["repo"], "z-recorded");
    assert_eq!(std::fs::read_to_string(log).unwrap().lines().collect::<Vec<_>>(), [recorded.to_str().unwrap(), fallback.to_str().unwrap()]);
}

#[test]
fn a_stalled_recorded_batch_cannot_skip_the_next_checkout() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let remote = f.remote("origin");
    let session = serde_json::from_value(json!({
        "id": "recorded", "projectPath": f.root, "cwd": f.root, "title": "fixture", "created": "", "modified": ""
    })).unwrap();
    crate::store::index::save(&[session]).unwrap();
    for number in 0..8 {
        let checkout = f.clone(&remote, &format!("slow-{number}"));
        let url = format!("https://github.com/acme/slow-{number}/pull/1");
        crate::pr_associations::record_local("recorded", &checkout, &url, "old").unwrap();
    }
    let checkout = f.clone(&remote, "valid");
    let valid_url = "https://github.com/acme/valid/pull/1";
    crate::pr_associations::record_local("recorded", &checkout, valid_url, "new").unwrap();
    git(&checkout, &["config", "terminalx.testGithubRepoUrl", "https://github.com/acme/valid"]);
    let shim = f.base.join("gh");
    let script = std::fs::read_to_string(&shim).unwrap();
    std::fs::write(&shim, script.replacen("#!/bin/sh\n", "#!/bin/sh\ncase \"$(pwd -P)\" in */slow-*) exec sleep 30 ;; esac\n", 1)).unwrap();
    let rows = f.call("git.prAssociations", json!({ "sessionId": "recorded" })).unwrap();
    let valid = rows["associations"].as_array().unwrap().iter().find(|row| row["url"] == valid_url).unwrap();
    assert_eq!(valid["repo"], "valid");
}

#[test]
fn a_rebound_pull_request_url_cannot_redirect_a_verified_write() {
    let f = fixture();
    let remote = f.remote("origin");
    f.clone(&remote, "app");
    let url = "https://github.test/octo/repo/pull/1";
    let original = json!({
        "id": "PR_original", "number": 1, "url": url, "state": "OPEN", "isDraft": true, "headRefName": "feature"
    });
    let replacement_state = f.base.join("replacement");
    std::fs::create_dir(&replacement_state).unwrap();
    let mut replacement = original.clone();
    replacement["id"] = json!("PR_replacement");
    let pr_file = f.state.join("pr-1.json");
    let replacement_file = replacement_state.join("pr-1.json");
    std::fs::write(&pr_file, original.to_string()).unwrap();
    std::fs::write(&replacement_file, replacement.to_string()).unwrap();
    std::fs::write(f.state.join("repo-url"), "https://github.test/octo/repo").unwrap();
    let rebound = f.base.join("rebound");
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/remote-runtime/fake-gh");
    // The URL resolves to a second PR as soon as the verification view finishes.
    std::fs::write(f.base.join("gh"), format!(
        "#!/bin/sh\nstate='{}'\nif [ \"$1\" = pr ] && [ -f '{}' ]; then state='{}'; fi\nFAKE_GH_STATE=\"$state\" '{}' \"$@\"\nstatus=$?\nif [ \"$1\" = pr ] && [ \"$2\" = view ]; then touch '{}'; fi\nexit \"$status\"\n",
        f.state.display(), rebound.display(), replacement_state.display(), fake.display(), rebound.display(),
    )).unwrap();
    assert_eq!(f.call("git.prReady", json!({ "repo": "app", "url": url })).unwrap()["pr"]["isDraft"], false);
    std::fs::remove_file(rebound).unwrap();
    assert_eq!(f.call("git.prMerge", json!({ "repo": "app", "url": url, "method": "squash" })).unwrap()["pr"]["state"], "MERGED");
    let saved: Value = serde_json::from_slice(&std::fs::read(pr_file).unwrap()).unwrap();
    let untouched: Value = serde_json::from_slice(&std::fs::read(replacement_file).unwrap()).unwrap();
    assert_eq!(saved["state"], "MERGED");
    assert_eq!(saved["isDraft"], false);
    assert_eq!(untouched, replacement);
}

#[test]
fn a_concurrent_machine_pr_is_reported_as_existing_and_keeps_its_single_session() {
    let _home = crate::store::temp_home();
    let mut f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, ".");
    f.git.project = true;
    let session = |id: &str| serde_json::from_value::<crate::store::index::SessionEntry>(json!({
        "id": id, "projectPath": f.root, "cwd": repo, "title": "fixture", "created": "", "modified": ""
    })).unwrap();
    crate::store::index::save(&[session("native"), session("other")]).unwrap();
    git(&repo, &["checkout", "-qb", "feature/race"]);
    f.call("git.push", json!({"repo": "."})).unwrap();
    f.fault("concurrent-create");

    let legacy_create = json!({"repo": ".", "title": "Create PR", "base": "main", "sessionId": "native"});
    let read = |session| f.call("git.prAssociations", json!({"sessionId": session})).unwrap()["associations"].clone();
    let mut create = legacy_create.clone();
    create["associateExisting"] = json!(false);
    let response = f.call("git.prCreate", create).unwrap();
    assert_eq!(response["pr"]["title"], "Opened by another contributor");
    assert_eq!(response["created"], false);
    assert_eq!(response["existing"], true);
    assert_eq!(response["reconciled"], true);
    assert_eq!(response["sessionAssociated"], false);
    assert_eq!(read("native"), json!([]));

    f.call("git.prLinkBranch", json!({
        "repo": ".", "branch": "feature/race", "sessionId": "other", "url": response["pr"]["url"],
    })).unwrap();
    let existing = f.call("git.prCreate", legacy_create).unwrap();
    assert_eq!(existing["existing"], true);
    assert_eq!(existing["sessionAssociated"], false);
    assert_eq!(read("native"), json!([]));
    assert_eq!(read("other").as_array().unwrap().len(), 1);
    assert_eq!(read("other")[0]["url"], response["pr"]["url"]);
    assert_eq!(f.gh_calls().matches(r#"["pr", "create","#).count(), 1);
}

#[test]
fn machine_branch_pr_links_are_verified_durable_and_removable() {
    let _home = crate::store::temp_home();
    let mut f = fixture();
    let remote = f.remote("origin");
    let root = f.clone(&remote, ".");
    f.git.project = true;
    git(&root, &["remote", "set-url", "origin", "https://github.com/acme/widgets.git"]);
    git(&root, &["worktree", "add", "-qb", "feature", "feature-tree"]);
    let checkout = root.join("feature-tree");
    let cwd = checkout.join("subdir");
    std::fs::create_dir(&cwd).unwrap();
    let session = |id: &str, project: &Path, cwd: &Path| serde_json::from_value::<crate::store::index::SessionEntry>(json!({
        "id": id, "projectPath": project, "cwd": cwd, "title": "fixture", "created": "", "modified": ""
    })).unwrap();
    let mut native = session("native", &root, &cwd);
    native.set_checkout_root(checkout.to_str());
    crate::store::index::save(&[native, session("outside", &f.base, &cwd)]).unwrap();

    let public_url = "https://github.com/acme/widgets/pull/1";
    let enterprise_url = "https://github.enterprise.test/acme/widgets/pull/2";
    let wrong_url = "https://github.com/acme/other/pull/1";
    std::fs::create_dir_all(&f.state).unwrap();
    let save_pr = |number, url, state, fork| {
        std::fs::write(f.state.join(format!("pr-{number}.json")), json!({
            "id": format!("PR_linked_{number}"), "url": url, "number": number, "title": "Branch PR", "headRefName": "feature",
            "state": state, "isCrossRepository": fork, "isDraft": true, "mergeable": "MERGEABLE",
        }).to_string()).unwrap();
    };
    save_pr(1, public_url, "OPEN", false);
    save_pr(2, enterprise_url, "OPEN", false);
    let closed = "https://github.com/acme/widgets/pull/3";
    let fork = "https://github.com/acme/widgets/pull/4";
    save_pr(3, closed, "CLOSED", false);
    save_pr(4, fork, "OPEN", true);
    let link = |url| json!({"sessionId": "native", "repo": "feature-tree", "branch": "feature", "url": url});
    let read = || f.call("git.prAssociations", json!({"sessionId": "native"})).unwrap();
    let mut wrong_scope = link(public_url);
    wrong_scope["sessionId"] = json!("outside");
    assert_eq!(f.code("git.prLinkBranch", wrong_scope), "not_found");
    let mut wrong_checkout = link(public_url);
    wrong_checkout["repo"] = json!(".");
    assert_eq!(f.code("git.prLinkBranch", wrong_checkout), "invalid_params");
    let mut wrong_branch = link(public_url);
    wrong_branch["branch"] = json!("main");
    assert_eq!(f.code("git.prLinkBranch", wrong_branch), "invalid_params");
    for url in [closed, fork, wrong_url] {
        assert_eq!(f.code("git.prLinkBranch", link(url)), "not_found");
    }
    assert_eq!(read()["associations"], json!([]));

    // Older local desktops saved the directory from which the user linked
    // the PR. Resolve it to the registered worktree even when its origin is
    // identical to the project root's origin.
    let legacy_cwd = checkout.join("legacy-subdir");
    std::fs::create_dir(&legacy_cwd).unwrap();
    crate::pr_associations::link_local("native", &legacy_cwd, public_url, "feature").unwrap();
    assert_eq!(f.call("git.prLinkBranch", link(enterprise_url)).unwrap()["sessionAssociated"], true);
    std::fs::remove_dir(cwd).unwrap();
    for url in [public_url, enterprise_url] {
        assert_eq!(f.call("git.prLinkBranch", link(url)).unwrap()["sessionAssociated"], true);
    }
    git(&checkout, &["checkout", "-qb", "next"]);
    std::fs::remove_dir(legacy_cwd).unwrap();
    std::fs::write(f.state.join("repo-url"), "https://github.com/acme/widgets").unwrap();
    let rows = read();
    assert_eq!(rows["branchPrLinks"], true);
    assert_eq!(rows["associations"], json!([
        {"url": public_url, "number": 1, "head": "feature", "repo": "feature-tree", "linked": true},
        {"url": enterprise_url, "number": 2, "head": "feature", "repo": null, "linked": true},
    ]));
    let legacy = json!({"repo": rows["associations"][0]["repo"], "number": 1, "url": public_url});
    assert_eq!(f.git.handle_negotiated("git.prs", &legacy, false).unwrap().unwrap()["prs"][0]["url"], public_url);

    std::fs::write(f.state.join("repo-url"), "https://github.enterprise.test/acme/widgets").unwrap();
    assert_eq!(read()["associations"], json!([
        {"url": public_url, "number": 1, "head": "feature", "repo": null, "linked": true},
        {"url": enterprise_url, "number": 2, "head": "feature", "repo": "feature-tree", "linked": true},
    ]));
    let legacy_rows = f.git.handle_negotiated("git.prAssociations", &json!({"sessionId":"native"}), false).unwrap().unwrap();
    let legacy_enterprise = &legacy_rows["associations"][1]["repo"];
    assert!(legacy_enterprise.as_str().unwrap().starts_with(LEGACY_PR_REPO_PREFIX));
    let legacy = json!({"repo": legacy_enterprise, "number": 2, "url": enterprise_url});
    assert_eq!(f.git.handle_negotiated("git.prs", &legacy, false).unwrap().unwrap()["prs"][0]["url"], enterprise_url);

    let exact = json!({"repo": "feature-tree", "number": 2, "url": enterprise_url});
    assert_eq!(f.call("git.prs", exact.clone()).unwrap()["prs"][0]["url"], enterprise_url);
    assert_eq!(f.call("git.prReady", exact.clone()).unwrap()["pr"]["isDraft"], false);
    assert_eq!(f.call("git.prMerge", exact).unwrap()["pr"]["state"], "MERGED");
    let calls = f.gh_calls();
    assert!(calls.lines().any(|line| line.contains("markPullRequestReadyForReview(") && line.contains("\"id=PR_linked_2\"")));
    assert!(calls.lines().any(|line| line.contains("mergePullRequest(") && line.contains("\"id=PR_linked_2\"")));

    // Same number after gh's checkout routing changes. Refuse before issuing
    // any GitHub mutation, even if the old locator still exists.
    std::fs::write(f.state.join("repo-url"), "https://github.com/acme/widgets").unwrap();
    save_pr(1, wrong_url, "OPEN", false);
    let stale_target = json!({"repo": "feature-tree", "number": 1, "url": public_url});
    for method in ["git.prs", "git.prReady", "git.prMerge"] {
        assert_eq!(f.code(method, stale_target.clone()), "not_found");
    }
    assert_eq!(f.gh_calls().matches("markPullRequestReadyForReview(").count(), 1);
    assert_eq!(f.gh_calls().matches("mergePullRequest(").count(), 1);
    f.call("git.prUnlink", json!({"sessionId": "native", "url": public_url})).unwrap();
    assert_eq!(read()["associations"].as_array().unwrap().len(), 1);
    assert_eq!(read()["associations"][0]["url"], enterprise_url);
    save_pr(1, public_url, "OPEN", false);
    let legacy_create = json!({
        "repo": "feature-tree", "title": "Existing", "base": "main", "branch": "feature", "sessionId": "native",
    });
    let mut create = legacy_create.clone();
    create["associateExisting"] = json!(false);
    let existing = f.call("git.prCreate", create).unwrap();
    assert_eq!(existing["existing"], true);
    assert_eq!(existing["sessionAssociated"], false);
    assert_eq!(read()["associations"].as_array().unwrap().len(), 1);

    let existing = f.call("git.prCreate", legacy_create.clone()).unwrap();
    assert_eq!(existing["existing"], true);
    assert_eq!(existing["sessionAssociated"], false);
    assert_eq!(read()["associations"].as_array().unwrap().len(), 1);

    let new_link = "https://github.com/acme/widgets/pull/5";
    save_pr(5, new_link, "OPEN", false);
    let existing = f.call("git.prCreate", legacy_create).unwrap();
    assert_eq!(existing["existing"], true);
    assert_eq!(existing["sessionAssociated"], true);
    assert_eq!(read()["associations"].as_array().unwrap().len(), 2);
    assert_eq!(read()["associations"][0]["url"], new_link);
    assert_eq!(read()["associations"][0]["linked"], true);
    f.call("git.prUnlink", json!({"sessionId": "native", "url": new_link})).unwrap();
    assert_eq!(read()["associations"].as_array().unwrap().len(), 1);
    git(&checkout, &["checkout", "feature"]);
    assert_eq!(f.call("git.prLinkBranch", link(public_url)).unwrap()["sessionAssociated"], true);
    git(&root, &["worktree", "remove", "feature-tree"]);
    assert!(read()["associations"][0]["repo"].is_null());
    assert!(!f.gh_calls().contains(r#"["pr", "create","#));
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
    assert_eq!(created["created"], false);
    assert_eq!(created["existing"], true);
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
fn a_merge_pinned_to_a_head_is_refused_once_the_head_has_moved() {
    let f = fixture();
    let remote = f.remote("origin");
    f.clone(&remote, "app");
    let head = "a".repeat(40);
    let pr = json!({
        "number": 8, "title": "Pinned", "url": "https://github.test/octo/repo/pull/8",
        "state": "OPEN", "headRefName": "feature/p", "baseRefName": "main", "headRefOid": head,
        "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "statusCheckRollup": []
    });
    std::fs::write(f.state.join("pr-8.json"), pr.to_string()).unwrap();
    assert_eq!(f.code("git.prMerge", json!({"repo":"app","number":8,"method":"squash","head":"not a sha"})), "invalid_params");
    assert_eq!(f.code("git.prMerge", json!({"repo":"app","number":8,"method":"squash","head":"b".repeat(40)})), "conflict");
    assert_eq!(f.call("git.prs", json!({"repo":"app","number":8})).unwrap()["prs"][0]["state"], "OPEN");
    let merged = f.call("git.prMerge", json!({"repo":"app","number":8,"method":"squash","head":head})).unwrap();
    assert_eq!(merged["pr"]["state"], "MERGED");
    assert!(f.gh_calls().contains(&format!("\"--match-head-commit\", \"{head}\"")));
}

#[test]
fn panel_queue_details_and_actions_follow_the_selected_repository() {
    let f = fixture();
    let remote = f.remote("origin");
    f.clone(&remote, "app");
    let pr = json!({
        "id": "PR_queue", "number": 7, "title": "Queued work", "url": "https://github.test/octo/repo/pull/7",
        "state": "OPEN", "headRefName": "main", "baseRefName": "develop", "headRefOid": "fake-head",
        "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED",
        "statusCheckRollup": [{"__typename":"CheckRun","name":"build","status":"IN_PROGRESS","conclusion":""}],
        "requiredChecks": ["build"]
    });
    std::fs::write(f.state.join("pr-7.json"), pr.to_string()).unwrap();
    // A queue click cannot silently enable auto-merge on a non-queue base.
    assert_eq!(f.code("git.prMerge", json!({"repo":"app","number":7,"method":"queue"})), "conflict");
    assert!(!f.gh_calls().contains("\"--auto\""));
    f.fault("merge-queue");
    let listed = f.call("git.prs", json!({"repo":"app"})).unwrap();
    assert_eq!(listed["prs"][0]["mergeQueueEnabled"], true);
    assert_eq!(listed["prs"][0]["requiredChecks"], json!(["build"]));
    assert!(listed["prs"][0]["detailsError"].is_null());
    f.call("git.prMerge", json!({"repo":"app","number":7,"method":"queue"})).unwrap();
    assert!(f.gh_calls().contains("[\"pr\", \"merge\", \"7\", \"--auto\"]"));
    let listed = f.call("git.prs", json!({"repo":"app","number":7})).unwrap();
    assert_eq!(listed["prs"][0]["state"], "OPEN");
    assert_eq!(listed["prs"][0]["mergeQueueEntry"], json!({"position":2,"state":"QUEUED"}));
    std::fs::write(f.state.join("repo-url"), "https://github.test/octo/repo").unwrap();
    let queue = |method| f.call("git.prMerge", json!({"repo":"app","url":pr["url"],"method":method})).unwrap();
    std::fs::write(f.state.join("pr-7.json"), pr.to_string()).unwrap();
    assert_eq!(queue("queue")["pr"]["autoMergeEnabled"], true);
    let mut clean = pr.clone();
    clean["mergeStateStatus"] = json!("CLEAN");
    for method in ["queue", "merge", "squash", "rebase"] {
        std::fs::write(f.state.join("pr-7.json"), clean.to_string()).unwrap();
        let result = queue(method);
        assert_eq!(result["pr"]["state"], "OPEN");
        assert_eq!(result["pr"]["mergeQueueEntry"], json!({"position":2,"state":"QUEUED"}));
    }
    let calls = f.gh_calls();
    assert!(calls.lines().any(|line| line.contains("enablePullRequestAutoMerge(") && line.contains("\"id=PR_queue\"")));
    assert!(calls.lines().any(|line| line.contains("enqueuePullRequest(") && line.contains("\"id=PR_queue\"")));
    assert!(!calls.contains("change: mergePullRequest("));
    f.fault("queue-offline");
    assert!(f.call("git.prMerge", json!({"repo":"app","url":pr["url"],"method":"squash"})).is_err());
    assert!(!f.gh_calls().contains("change: mergePullRequest("));
    let listed = f.call("git.prs", json!({"repo":"app","number":7})).unwrap();
    assert_eq!(listed["prs"][0]["number"], 7);
    assert!(listed["prs"][0]["detailsError"].as_str().unwrap().contains("connecting"));
    assert!(listed["prs"][0]["mergeQueueEntry"].is_null());
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

#[test]
fn workspace_review_range_includes_committed_modified_and_untracked() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    git(&repo, &["checkout", "-qb", "feature"]);
    std::fs::write(repo.join("A"), "committed\n").unwrap();
    git(&repo, &["add", "A"]);
    git(&repo, &["commit", "-qm", "A"]);
    std::fs::write(repo.join("README.md"), "modified\n").unwrap();
    std::fs::write(repo.join("C"), "untracked\n").unwrap();
    for (uncommitted, count) in [(false, 3), (true, 2)] {
        let range = f.call("git.reviewRange", json!({ "repo": "app", "uncommitted": uncommitted })).unwrap();
        assert_eq!(range["target"], if uncommitted { "HEAD" } else { "origin/main" });
        let files = f.call("git.changesBetween", json!({ "repo": "app", "base": range["base"], "head": range["head"] })).unwrap();
        assert_eq!(files["files"].as_array().unwrap().len(), count);
        let contents = f.call("git.fileContents", json!({ "repo": "app", "path": "C", "base": range["base"], "head": range["head"] })).unwrap();
        assert_eq!(contents["after"], "untracked\n");
    }
    assert!(f.call("git.reviewRange", json!({ "repo": "app", "target": "missing" })).is_err());
}

#[test]
fn session_pr_evidence_is_read_from_the_runtime_and_routed_by_repository() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    let other = f.clone(&remote, "libs/other");
    git(&repo, &["config", "terminalx.testGithubRepoUrl", "https://github.com/acme/widgets"]);
    git(&other, &["config", "terminalx.testGithubRepoUrl", "https://github.com/acme/other"]);
    let session = |id: &str, path: &Path| serde_json::from_value::<crate::store::index::SessionEntry>(json!({
        "id": id, "projectPath": path, "cwd": path, "title": "fixture", "created": "", "modified": ""
    })).unwrap();
    let mut foreign_checkout = session("foreign-checkout", &f.base);
    foreign_checkout.cwd = repo.to_string_lossy().into_owned();
    crate::store::index::save(&[session("author", &f.root), session("unrelated", &f.root), session("outside", &f.base), foreign_checkout, session("nested", &repo)]).unwrap();
    // Denial must happen before recovery creates/reads the association registry.
    let registry = crate::store::root().unwrap().join("session-pr-associations.json");
    assert!(!registry.exists());
    for id in ["foreign-checkout", "outside"] {
        assert_eq!(f.code("git.prAssociations", json!({"sessionId":id})), "not_found");
        assert!(!registry.exists());
    }
    assert!(f.call("git.prAssociations", json!({"sessionId":"nested"})).is_ok());
    let journal = crate::store::log_path("author", "tab").unwrap();
    for (seq, payload) in [
        json!({"type":"tool_call_started", "callId":"create", "name":"Bash", "toolType":"shell", "input":{"command":"gh pr create --body-file - <<'EOF'\nUse `code`.\nEOF"}}),
        json!({"type":"tool_call_completed", "callId":"create", "result":{"text":"https://github.com/acme/widgets/pull/1", "exitCode":0}}),
    ].into_iter().enumerate() {
        crate::store::append_line(&journal, &json!({"id":seq.to_string(),"sessionId":"author","tabId":"tab","harness":"claude","seq":seq,"ts":"","payload":payload}).to_string()).unwrap();
    }
    let pipeline: crate::issue_pipeline::Pipeline = serde_json::from_value(json!({
        "id":"fixture", "projectPath":f.root, "issue":{"provider":"github","id":"1","identifier":"#1","title":"fixture","url":"https://github.com/acme/other/issues/1"},
        "branch":"followup", "author":{"sessionId":"author","tabId":"tab"}, "cloud":true,
        "stage":"review","state":"working","maxRounds":3,"created":"","modified":"",
        "pr":{"number":1,"url":"https://github.com/acme/other/pull/1","base":"main"}
    })).unwrap();
    crate::issue_pipeline::store::insert(&pipeline).unwrap();
    crate::pr_associations::record_local("unrelated", &repo, "https://github.com/acme/widgets/pull/99", "main").unwrap();
    let linked_url = "https://github.com/acme/widgets/pull/2";
    crate::pr_associations::link("author", crate::pr_associations::Association {
        url: linked_url.into(), number: 2, head: "another-branch".into(),
        scope: crate::pr_associations::Scope::Local { cwd: repo.to_string_lossy().into_owned() },
        linked: false,
    }).unwrap();
    let read = || f.call("git.prAssociations", json!({"sessionId":"author"})).unwrap();
    let first = read();
    assert_eq!(f.git.handle_negotiated("git.prAssociations", &json!({"sessionId":"author"}), false).unwrap().unwrap(), first);
    let associations = first["associations"].as_array().unwrap();
    assert_eq!(associations.len(), 3);
    assert!(associations.iter().any(|a| a["url"] == "https://github.com/acme/widgets/pull/1" && a["repo"] == "app" && a["linked"] == false));
    assert!(associations.iter().any(|a| a["url"] == "https://github.com/acme/other/pull/1" && a["repo"] == "libs/other" && a["linked"] == false));
    assert!(associations.iter().any(|a| a["url"] == linked_url && a["repo"] == "app" && a["linked"] == true));
    // The registry survives journal/pipeline pruning and a different branch.
    std::fs::remove_file(journal).unwrap();
    crate::store::write_json(&crate::store::root().unwrap().join("issue-pipelines.json"), &json!({"pipelines":[]})).unwrap();
    git(&repo, &["checkout", "-b", "next"]);
    assert_eq!(read(), first);
    assert_eq!(f.code("git.prAssociations", json!({"sessionId":"outside"})), "not_found");
    assert_eq!(f.code("git.prAssociations", json!({"sessionId":"missing"})), "not_found");
    std::fs::remove_dir_all(other).unwrap();
    let unavailable = read();
    assert_eq!(unavailable["associations"].as_array().unwrap().len(), 3);
    assert!(unavailable["associations"].as_array().unwrap().iter().any(|a| a["repo"].is_null()));
}

#[test]
fn remote_landed_verification_recognizes_rewritten_merges_but_not_new_work() {
    for method in ["squash", "rebase"] {
        let f = fixture();
        let remote = f.remote("origin");
        let repo = f.clone(&remote, "app");
        git(&repo, &["checkout", "-b", "feature"]);
        std::fs::write(repo.join("feature.txt"), "feature\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "feature"]);
        std::fs::write(repo.join("feature.txt"), "feature\nsecond change\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "second feature change"]);
        git(&repo, &["push", "-u", "origin", "feature"]);
        git(&repo, &["checkout", "main"]);
        std::fs::write(repo.join("other.txt"), "other\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "other"]);
        if method == "squash" {
            git(&repo, &["merge", "--squash", "feature"]);
            git(&repo, &["commit", "-m", "squash feature"]);
        } else {
            git(&repo, &["cherry-pick", "main..feature"]);
        }
        git(&repo, &["push", "origin", "main"]);
        git(&repo, &["checkout", "feature"]);
        assert!(crate::git::work_status(&repo).ahead_of_base.unwrap() > 0);
        let landed = f.call("git.prLanded", json!({"repo":"app"})).unwrap();
        assert_eq!(landed["safe"], true, "{method}: {landed}");
        assert_eq!(landed["merged"], method);
        assert_eq!(landed["head"], git(&repo, &["rev-parse", "HEAD"]));
        std::fs::write(repo.join("followup.txt"), "new work\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "follow-up"]);
        assert_eq!(f.call("git.prLanded", json!({"repo":"app"})).unwrap()["safe"], false);
        git(&repo, &["remote", "set-url", "origin", "http://127.0.0.1:9/acme/repo.git"]);
        assert!(f.call("git.prLanded", json!({"repo":"app"})).is_err());
    }
}

#[test]
fn conversation_uses_workspace_credentials_and_rejects_unrelated_repositories() {
    let f = fixture();
    let remote = f.remote("origin");
    f.clone(&remote, "app");
    std::fs::write(f.state.join("repo-url"), "https://github.com/acme/widgets").unwrap();
    std::fs::write(f.state.join("conversation.json"), include_str!("../fixtures/github_pr_conversation.json")).unwrap();
    let params = json!({ "repo": "app", "url": "https://github.com/acme/widgets/pull/799" });
    let result = f.call("git.prConversation", params).unwrap();
    assert_eq!(result["activity"].as_array().unwrap().len(), 11);
    assert!(f.gh_calls().contains("graphql"));
    let calls = f.gh_calls().lines().count();
    for method in ["git.prConversation", "git.prReviewerSearch", "git.prConversationAction"] {
        assert_eq!(f.code(method, json!({ "repo": "app", "url": "https://github.com/other/private/pull/799", "query": "ada", "action": {"kind":"request","login":"ada","team":false} })), "invalid_params");
    }
    // Only the repository identity lookup ran; no query, search or write did.
    assert_eq!(f.gh_calls().lines().count(), calls + 3);
}

#[test]
fn cloud_approval_is_refused_before_running_gh_even_with_a_personal_viewer_claim() {
    let f = fixture();
    let remote = f.remote("origin");
    f.clone(&remote, "app");
    for viewer in ["author", "reviewer", "organisation-app[bot]"] {
        let error = f.call("git.prConversationAction", json!({
            "repo":"app", "url":"https://github.com/acme/widgets/pull/799",
            "action":{"kind":"approve","viewer":viewer}
        })).unwrap_err();
        assert_eq!(error.code, "forbidden");
        assert!(error.message.contains("personal account"));
    }
    assert!(f.gh_calls().is_empty(), "approval must never use the App token");
}

#[test]
fn log_limits_commits_to_the_selected_base_branch() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    for i in 0..3 {
        git(&repo, &["commit", "--allow-empty", "-m", &format!("main {i}")]);
    }
    git(&repo, &["checkout", "-b", "feature"]);
    let range = json!({ "repo": "app", "from": "main..HEAD", "limit": 8 });
    assert_eq!(f.call("git.log", range.clone()).unwrap()["commits"], json!([]));
    git(&repo, &["commit", "--allow-empty", "-m", "branch change"]);
    let log = f.call("git.log", range).unwrap();
    assert_eq!(log["commits"].as_array().unwrap().len(), 1);
    assert_eq!(log["commits"][0]["subject"], "branch change");
    for from in ["--all..HEAD", "main...HEAD", "main~1..HEAD", "main..HEAD~1"] {
        assert_eq!(f.code("git.log", json!({ "repo": "app", "from": from })), "invalid_params");
    }
}

#[test]
fn oversized_file_contents_keep_actual_revision_byte_sizes() {
    let f = fixture();
    let remote = f.remote("origin");
    let repo = f.clone(&remote, "app");
    // Beyond both the desktop and relay preview limits; count bytes, not characters.
    let text = "é".repeat(3 * 1024 * 1024);
    std::fs::write(repo.join("large.txt"), &text).unwrap();
    f.call("git.commit", json!({ "repo": "app", "message": "large", "author": me() })).unwrap();
    let log = f.call("git.log", json!({ "repo": "app", "limit": 1 })).unwrap();
    let tree = &log["commits"][0]["tree"];
    let working = f.call("git.fileContents", json!({ "repo": "app", "path": "large.txt", "base": tree })).unwrap();
    assert_eq!(working["after"], "<file too large to show>");
    assert_eq!(working["afterSize"], text.len());
    std::fs::write(repo.join("large.txt"), "small").unwrap();
    let pair = f.call("git.fileContents", json!({ "repo": "app", "path": "large.txt", "base": tree })).unwrap();
    assert_eq!(pair["before"], "<file too large to show>");
    assert_eq!(pair["beforeSize"], text.len());
    assert_eq!(pair["afterSize"], 5);
    let snapshot = f.call("git.fileContents", json!({ "repo": "app", "path": "large.txt", "base": tree, "head": tree })).unwrap();
    assert_eq!(snapshot["afterSize"], text.len());
    std::fs::remove_file(repo.join("large.txt")).unwrap();
    let deleted = f.call("git.fileContents", json!({ "repo": "app", "path": "large.txt", "base": tree })).unwrap();
    assert!(deleted["afterSize"].is_null());
}
