//! Verification refreshes only the superproject's comparison branch. A real
//! initialized SSH submodule keeps its own identity and is never fetched by it.
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

struct Repositories {
    project: PathBuf,
    seed: PathBuf,
    remote: PathBuf,
    child: PathBuf,
    child_seed: PathBuf,
    child_command: String,
    parent_command: String,
}

fn quote(path: &Path) -> String { format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''")) }

fn wrapper(path: &Path, source: &str) {
    std::fs::write(path, source).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn calls(root: &Path, role: &str) -> usize {
    std::fs::read_to_string(root.join("submodule-launches")).unwrap_or_default()
        .lines().filter(|line| line.starts_with(role)).count()
}

fn default_ssh_calls(root: &Path) -> usize {
    std::fs::read_to_string(root.join("launches")).unwrap_or_default()
        .lines().filter(|line| line.starts_with("ssh ")).count()
}

fn fixture(root: &Path) -> Repositories {
    let directory = root.join("initialized-submodule");
    std::fs::create_dir(&directory).unwrap();
    let child_seed = directory.join("child-seed");
    let seed = directory.join("parent-seed");
    for path in [&child_seed, &seed] {
        std::fs::create_dir(path).unwrap();
        real_git(path, &["init", "-q", "-b", "main"]);
        real_git(path, &["commit", "--allow-empty", "-qm", "Seed repository"]);
    }
    let child_remote = directory.join("child-origin.git");
    let remote = directory.join("parent-origin.git");
    real_git(&directory, &["clone", "-q", "--bare", child_seed.to_str().unwrap(), child_remote.to_str().unwrap()]);
    real_git(&child_seed, &["remote", "add", "origin", child_remote.to_str().unwrap()]);
    real_git(&seed, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", child_remote.to_str().unwrap(), "child"]);
    real_git(&seed, &["commit", "-qm", "Record real submodule"]);
    real_git(&directory, &["clone", "-q", "--bare", seed.to_str().unwrap(), remote.to_str().unwrap()]);
    real_git(&seed, &["remote", "add", "origin", remote.to_str().unwrap()]);
    let project = directory.join("parent");
    real_git(&directory, &["clone", "-q", remote.to_str().unwrap(), project.to_str().unwrap()]);
    real_git(&project, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
    let child = project.join("child");
    assert!(child.join(".git").is_file(), "must be an initialized submodule, not a nested mock repository");
    assert_eq!(crate::landed::submodules_in(&project), Some(1));

    let child_wrapper = directory.join("child identity wrapper");
    wrapper(&child_wrapper, r#"#!/bin/sh
printf 'child %s\n' "$$" >> "$TERMINALX_HOME/submodule-launches"
[ "$#" = 4 ] && [ "$1" = --identity ] && [ "$2" = child-only-key ] && [ "$3" = child-user@child.invalid ] || exit 91
exec /bin/sh -c "$4"
"#);
    let parent_wrapper = directory.join("parent identity wrapper");
    wrapper(&parent_wrapper, r#"#!/bin/sh
printf 'parent %s\n' "$$" >> "$TERMINALX_HOME/submodule-launches"
[ "$1" = --identity ] && [ "$2" = parent-only-key ] || exit 92
shift 2
if [ "$1" = -G ]; then
  printf 'hostname parent.invalid\nuser parent-user\nport 22\nproxycommand none\nproxyjump none\nforkafterauthentication no\npermitlocalcommand no\n'
  exit 0
fi
while [ "$#" -gt 2 ]; do
  case "$1" in
    -S) [ "$2" = none ] || exit 93; shift 2 ;;
    -o) case "$2" in SendEnv=GIT_PROTOCOL|ProxyCommand=none|ForkAfterAuthentication=no|PermitLocalCommand=no) ;; *) exit 94 ;; esac; shift 2 ;;
    *) exit 95 ;;
  esac
done
[ "$#" = 2 ] && [ "$1" = parent-user@parent.invalid ] || exit 96
if [ -f "$TERMINALX_HOME/hold-submodule-parent" ]; then
  : > "$TERMINALX_HOME/held-$$"
  exec /bin/sleep 30
fi
exec /bin/sh -c "$2"
"#);
    let child_command = format!("{} --identity child-only-key", quote(&child_wrapper));
    let parent_command = format!("{} --identity parent-only-key", quote(&parent_wrapper));
    real_git(&child, &["remote", "set-url", "origin", &format!("ssh://child-user@child.invalid{}", child_remote.display())]);
    real_git(&child, &["config", "core.sshCommand", &child_command]);
    real_git(&child, &["config", "ssh.variant", "simple"]);
    real_git(&project, &["config", "fetch.recurseSubmodules", "true"]);
    real_git(&project, &["config", "submodule.recurse", "true"]);
    Repositories { project, seed, remote, child, child_seed, child_command, parent_command }
}

impl Repositories {
    fn advance(&self) -> (String, String) {
        let mut heads = Vec::new();
        for seed in [&self.seed, &self.child_seed] {
            real_git(seed, &["commit", "--allow-empty", "-qm", "Advance remote"]);
            real_git(seed, &["push", "-q", "origin", "main"]);
            heads.push(real_git(seed, &["rev-parse", "HEAD"]));
        }
        (heads.remove(0), heads.remove(0))
    }

    fn fetch(&self) -> bool {
        let (base, why, fresh) = crate::landed::base_for(&self.project, crate::landed::Fetch::Fresh);
        assert_eq!(base.as_deref(), Some("origin/main"));
        if !fresh {
            let why = why.unwrap();
            assert!(why.contains(data_privacy::MESSAGE), "{why}");
        }
        fresh
    }

    fn child_unchanged(&self, root: &Path, before: usize, head: &str) {
        assert_eq!(calls(root, "child"), before, "verification entered the child transport");
        assert_eq!(real_git(&self.child, &["rev-parse", "origin/main"]), head, "verification refreshed child refs");
        assert_eq!(real_git(&self.child, &["config", "core.sshCommand"]), self.child_command);
        assert_eq!(real_git(&self.child, &["config", "ssh.variant"]), "simple");
        assert_eq!(real_git(&self.project, &["config", "fetch.recurseSubmodules"]), "true", "do not persist a recursion override");
    }

    fn verify_fresh(&self, root: &Path) {
        let child_calls = calls(root, "child");
        let child_head = real_git(&self.child, &["rev-parse", "origin/main"]);
        let defaults = default_ssh_calls(root);
        let (parent, child) = self.advance();
        assert_ne!(child, child_head);
        assert!(self.fetch());
        assert_eq!(real_git(&self.project, &["rev-parse", "origin/main"]), parent);
        self.child_unchanged(root, child_calls, &child_head);
        assert_eq!(default_ssh_calls(root), defaults, "fell back to a different SSH identity");
        let landed = crate::landed::check(&self.project, &self.project, crate::landed::Fetch::JustFetched);
        assert!(landed.checked && landed.fresh);
        assert!(!landed.safe && landed.not_verified.as_deref().is_some_and(|why| why.contains("submodule")), "fresh superproject refs must not imply verified child work: {landed:?}");
    }

    fn ordinary_recursive_fetch(&self, root: &Path) {
        let before = calls(root, "child");
        let (_, expected) = self.advance();
        // Positive control: the same real initialized child is fetched through
        // its OWN identity by ordinary Git, using configured recursion. No app
        // helper, replacement SSH or manually invoked child stands in for it.
        real_git(&self.project, &["fetch", "--quiet", "origin", "main"]);
        assert!(calls(root, "child") > before, "fixture never exercised real recursion");
        assert_eq!(real_git(&self.child, &["rev-parse", "origin/main"]), expected);
    }
}

pub(super) fn run(root: &Path, managed: bool) {
    let saved: Vec<_> = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"].into_iter()
        .map(|key| (key, std::env::var_os(key))).collect();
    for (key, _) in &saved { std::env::remove_var(key); }
    policy(false, managed);
    let fixture = fixture(root);
    for ssh in [false, true] {
        println!("privacy initialized submodule: managed={managed}/ssh-superproject={ssh}");
        if ssh {
            real_git(&fixture.project, &["remote", "set-url", "origin", &format!("ssh://parent-user@parent.invalid{}", fixture.remote.display())]);
            real_git(&fixture.project, &["config", "core.sshCommand", &fixture.parent_command]);
            real_git(&fixture.project, &["config", "ssh.variant", "auto"]);
        } else {
            real_git(&fixture.project, &["config", "core.sshCommand", "ssh"]);
            real_git(&fixture.project, &["config", "ssh.variant", "ssh"]);
        }
        fixture.ordinary_recursive_fetch(root);
        fixture.verify_fresh(root);
        let before = (launches(root), calls(root, ""));
        let child_calls = calls(root, "child");
        let child_head = real_git(&fixture.child, &["rev-parse", "origin/main"]);
        policy(true, managed);
        assert!(!fixture.fetch());
        assert_eq!((launches(root), calls(root, "")), before);
        policy(false, managed);
        let stale = super::super::super::queued(|| fixture.fetch());
        policy(true, managed);
        policy(false, managed);
        assert!(!stale());
        assert_eq!((launches(root), calls(root, "")), before, "stale verification launched a transport");

        let hold = root.join(if ssh { "hold-submodule-parent" } else { "hold" });
        std::fs::write(&hold, if ssh { "" } else { "fetch\n" }).unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(super::super::super::queued(|| fixture.fetch()));
            wait_for_fetch(root, || worker.is_finished());
            cancel_fetch(root, managed);
            assert!(!worker.join().unwrap());
        });
        fixture.child_unchanged(root, child_calls, &child_head);
        std::fs::remove_file(hold).unwrap();
        for pid in held(root) { std::fs::remove_file(root.join(format!("held-{pid}"))).unwrap(); }
        let after = (launches(root), calls(root, ""));
        policy(false, managed);
        assert_eq!((launches(root), calls(root, "")), after, "restoration replayed cancelled work");
        fixture.verify_fresh(root);
        fixture.ordinary_recursive_fetch(root);
    }
    for (key, value) in saved {
        if let Some(value) = value { std::env::set_var(key, value); } else { std::env::remove_var(key); }
    }
}
