//! Actual clone configuration and prepared reference-transaction cancellation.
use super::*;
use std::os::unix::fs::PermissionsExt;

pub(super) fn run(root: &Path, managed: bool) {
    let _environment = Environment::new(root);
    policy(false, managed);
    let f = Fixture::new(root, "native3-config");
    let directory = f.cwd.parent().unwrap();
    let records = directory.join("identities");
    let command = git(&f.cwd, &["config", "core.sshCommand"]);
    let mut commands = Vec::new();
    for name in ["global", "enclosing", "clone-option", "command-line"] {
        let wrapper = directory.join(name);
        std::fs::write(&wrapper, format!("#!/bin/sh\ncase \" $* \" in *' -G '*) ;; *) printf '%s\\n' '{name}' >> {} ;; esac\nexec {command} \"$@\"\n", quote(&records))).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        commands.push(quote(&wrapper));
    }
    let global = directory.join("global.config");
    let saved = std::env::var_os("GIT_CONFIG_GLOBAL");
    std::env::set_var("GIT_CONFIG_GLOBAL", &global);
    git(&f.cwd, &["config", "--global", "core.sshCommand", &commands[0]]);
    git(&f.cwd, &["config", "--global", "ssh.variant", "simple"]);
    git(&f.cwd, &["config", "core.sshCommand", &commands[1]]);
    let clone = |name: &str, ordinary: bool, prefix: &[&str], options: &[&str]| {
        let mut args = prefix.to_vec(); args.push("clone"); args.extend(options);
        args.extend(["--", "ssh://privacy-pull/fixture.git", name]);
        if ordinary {
            let out = Command::new("/usr/bin/git").current_dir(&f.cwd).args(&args).env("TERMINALX_TEST_ORDINARY_GIT", "1").output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        } else { crate::git::run(&f.cwd, &args).unwrap(); }
        assert_eq!(git(&f.cwd.join(name), &["rev-parse", "HEAD"]), f.after);
        assert_eq!(std::fs::read(f.cwd.join(name).join(FILE)).unwrap(), NEW);
    };
    clone("plain", true, &[], &[]);
    clone("app", false, &[], &[]);
    clone("option", false, &[], &["-c", &format!("core.sshCommand={}", commands[2])]);
    clone("cli", false, &["-c", &format!("core.sshCommand={}", commands[3])], &[]);
    assert_eq!(std::fs::read_to_string(&records).unwrap().lines().collect::<Vec<_>>(), ["global", "global", "clone-option", "command-line"]);
    if let Some(value) = saved { std::env::set_var("GIT_CONFIG_GLOBAL", value); } else { std::env::remove_var("GIT_CONFIG_GLOBAL"); }

    let f = Fixture::new(root, "native3-reference-lock");
    let hook = f.cwd.join(".git/hooks/reference-transaction");
    let entered = f.cwd.parent().unwrap().join("prepared");
    std::fs::write(&hook, format!("#!/bin/sh\n[ \"$1\" = prepared ] || exit 0\nprintf '%s\\n' \"$$\" > {ready}.tmp\n/bin/mv {ready}.tmp {ready}\nexec /bin/sleep 30\n", ready=quote(&entered))).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let lock = f.cwd.join(".git/refs/remotes/origin/main.lock");
    std::thread::scope(|scope| {
        let work = scope.spawn(crate::github_process::queued(|| crate::git::fetch_admitted(&f.cwd, "main", Duration::from_secs(15))));
        // Let the fetch's own 15-second deadline report a launch/transport
        // failure, rather than racing it with a shorter fixture deadline.
        let until = Instant::now() + Duration::from_secs(17);
        while !entered.exists() {
            if work.is_finished() { panic!("fetch ended before the prepared hook: {:?}", work.join().unwrap()); }
            assert!(Instant::now() < until, "fetch did not reach the prepared hook or settle its deadline");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(lock.exists(), "must cancel inside the prepared reference transaction");
        let pid: i32 = std::fs::read_to_string(&entered).unwrap().trim().parse().unwrap();
        policy(true, managed);
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert!(!lock.exists(), "Git must remove its own reference lock before acknowledgement");
        assert!(work.join().unwrap().unwrap_err().to_string().contains(data_privacy::MESSAGE));
    });
    f.missing(); // verification did not demand-fetch promised media
    assert!(std::fs::read_to_string(&f.transfers).unwrap().lines().all(|line| line.split_whitespace().nth(1) == Some("1")));
    std::fs::remove_file(hook).unwrap(); policy(false, managed);
    crate::git::fetch_admitted(&f.cwd, "main", Duration::from_secs(8)).unwrap();
    assert_eq!(git(&f.cwd, &["rev-parse", "origin/main"]), f.after);
    f.missing();
}
