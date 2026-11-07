//! Real Git chooses the variant and talks to upload-pack through strict observed
//! transports. A simple wrapper rejects -G and accepts ONLY host/remote command.
use super::*;
use std::os::unix::fs::PermissionsExt;

fn count(root: &Path, phase: &str) -> usize {
    std::fs::read_to_string(root.join("variant-launches")).unwrap_or_default()
        .lines().filter(|line| line.starts_with(phase)).count()
}

fn fetch(fixture: &FetchFixture) -> bool {
    let (base, why, fresh) = crate::landed::base_for(&fixture.project, crate::landed::Fetch::Fresh);
    assert_eq!(base.as_deref(), Some("origin/main"));
    if !fresh { assert!(why.unwrap().contains(data_privacy::MESSAGE)); }
    fresh
}

fn restored(root: &Path, fixture: &FetchFixture, probe: bool) {
    let before = (count(root, "probe"), count(root, "transfer"));
    let expected = fixture.advance();
    assert!(fetch(fixture), "configured transport must complete a real Fresh fetch");
    assert_eq!(real_git(&fixture.project, &["rev-parse", "origin/main"]), expected);
    assert_eq!(count(root, "probe"), before.0 + usize::from(probe));
    assert_eq!(count(root, "transfer"), before.1 + 1);
}

fn exercise(root: &Path, fixture: &FetchFixture, managed: bool, probe: bool) {
    policy(false, managed);
    restored(root, fixture, probe);
    let before = count(root, "");
    policy(true, managed);
    assert!(!fetch(fixture));
    assert_eq!(count(root, ""), before, "enabled policy launched a probe/transfer");
    policy(false, managed);
    let stale = super::super::super::queued(|| fetch(fixture));
    policy(true, managed);
    policy(false, managed);
    assert!(!stale());
    assert_eq!(count(root, ""), before, "queued request revived after on/off");
    restored(root, fixture, probe);

    for phase in ["probe", "transfer"] {
        if phase == "probe" && !probe { continue; }
        let before_transfer = count(root, "transfer");
        std::fs::write(root.join("hold-variant"), phase).unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(super::super::super::queued(|| fetch(fixture)));
            let until = Instant::now() + Duration::from_secs(10);
            while held(root).is_empty() {
                assert!(!worker.is_finished(), "{phase} ended before the observed pause");
                assert!(Instant::now() < until, "no {phase} process reached");
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(count(root, "transfer"), before_transfer + usize::from(phase == "transfer"));
            // Checks every recorded physical PID is dead before activation
            // returns. Probe and transfer share the original admission/lease.
            cancel_fetch(root, managed);
            assert!(!worker.join().unwrap());
        });
        if phase == "probe" {
            assert_eq!(count(root, "transfer"), before_transfer, "cancelled probe launched a transfer");
        }
        std::fs::remove_file(root.join("hold-variant")).unwrap();
        for pid in held(root) { std::fs::remove_file(root.join(format!("held-{pid}"))).unwrap(); }
        let after = count(root, "");
        policy(false, managed);
        assert_eq!(count(root, ""), after, "restoration replayed cancelled work");
        restored(root, fixture, probe);
    }
}

pub(super) fn run(root: &Path, fixture: &FetchFixture, managed: bool) {
    let saved: Vec<_> = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"].into_iter()
        .map(|key| (key, std::env::var_os(key))).collect();
    let directory = root.join("variant wrappers' directory");
    std::fs::create_dir(&directory).unwrap();
    let script = r#"#!/bin/sh
mode=
IFS= read -r mode < "$TERMINALX_HOME/variant-mode"
phase=transfer
if [ "$1" = -G ]; then phase=probe; fi
printf '%s %s\n' "$phase" "$$" >> "$TERMINALX_HOME/variant-launches"
printf '%s\n' "$phase" "$0" "$@" >> "$TERMINALX_HOME/variant-arguments"
hold=
if [ -f "$TERMINALX_HOME/hold-variant" ]; then IFS= read -r hold < "$TERMINALX_HOME/hold-variant"; fi
if [ "$phase" = probe ]; then
  if [ "$hold" = probe ]; then
    : > "$TERMINALX_HOME/held-$$"
    exec /bin/sleep 30
  fi
  case "$mode" in simple) exit 1 ;; ssh) exit 0 ;; *) exit 99 ;; esac
fi
case "$mode" in
 simple)
   [ "$#" = 2 ] && [ "$1" = configured-user@fixture.invalid ] || exit 91
   remote="$2" ;;
 plink|tortoiseplink)
   if [ "$mode" = tortoiseplink ]; then [ "$1" = -batch ] || exit 92; shift; fi
   [ "$#" = 4 ] && [ "$1" = -P ] && [ "$2" = 2222 ] && [ "$3" = configured-user@fixture.invalid ] || exit 93
   remote="$4" ;;
 ssh)
   contained=no
   while [ "$#" -gt 2 ]; do
     case "$1" in
       -S) [ "$2" = none ] || exit 94; contained=yes; shift 2 ;;
       -o) [ "$2" = SendEnv=GIT_PROTOCOL ] || exit 95; shift 2 ;;
       *) exit 96 ;;
     esac
   done
   [ "$contained" = yes ] && [ "$#" = 2 ] && [ "$1" = configured-user@fixture.invalid ] || exit 97
   remote="$2" ;;
 *) exit 98 ;;
esac
if [ "$hold" = transfer ]; then
  : > "$TERMINALX_HOME/held-$$"
  exec /bin/sleep 30
fi
exec /bin/sh -c "$remote"
"#;
    let remote = root.join("fetch-origin.git");
    // (name, env variant, config variant, command source, basename, grammar, probe)
    for (name, env, config, source, basename, grammar, probe) in [
        ("simple-unset-path", None, None, "path", "strict wrapper", "simple", true),
        ("simple-auto-path", Some("auto"), Some("ssh"), "path", "strict wrapper", "simple", true),
        ("simple-auto-core", None, Some("auto"), "core", "strict wrapper", "simple", true),
        ("simple-unset-command", None, None, "command", "strict wrapper", "simple", true),
        ("simple-explicit", Some("simple"), None, "command", "strict wrapper", "simple", false),
        ("ssh-auto", Some("auto"), None, "command", "strict wrapper", "ssh", true),
        ("ssh-unknown-env", Some("future-variant"), Some("simple"), "command", "strict wrapper", "ssh", false),
        ("ssh-unknown-config", None, Some("future-variant"), "core", "strict wrapper", "ssh", false),
        ("ssh-basename", None, None, "path", "ssh", "ssh", false),
        ("plink-basename", None, None, "path", "plink", "plink", false),
        ("tortoiseplink-basename", Some("auto"), None, "core", "TortoisePlink.exe", "tortoiseplink", false),
        ("putty-explicit", Some("putty"), None, "command", "putty", "plink", false),
    ] {
        println!("privacy SSH variant: managed={managed}/{name}");
        for (key, _) in &saved { std::env::remove_var(key); }
        for key in ["core.sshCommand", "ssh.variant"] {
            let _ = Command::new("/usr/bin/git").current_dir(&fixture.project).args(["config", "--unset", key]).status();
        }
        let wrapper = directory.join(basename);
        std::fs::write(&wrapper, script).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(root.join("variant-mode"), format!("{grammar}\n")).unwrap();
        if let Some(value) = env { std::env::set_var("GIT_SSH_VARIANT", value); }
        if let Some(value) = config { real_git(&fixture.project, &["config", "ssh.variant", value]); }
        let quoted = format!("'{}'", wrapper.to_str().unwrap().replace('\'', "'\\''"));
        match source {
            "path" => std::env::set_var("GIT_SSH", &wrapper),
            "command" => std::env::set_var("GIT_SSH_COMMAND", &quoted),
            "core" => { real_git(&fixture.project, &["config", "core.sshCommand", &quoted]); }
            _ => unreachable!(),
        }
        let port = if matches!(grammar, "plink" | "tortoiseplink") { ":2222" } else { "" };
        real_git(&fixture.project, &["remote", "set-url", "origin", &format!("ssh://configured-user@fixture.invalid{port}{}", remote.display())]);
        exercise(root, fixture, managed, probe);
    }
    real_git(&fixture.project, &["remote", "set-url", "origin", remote.to_str().unwrap()]);
    for key in ["core.sshCommand", "ssh.variant"] {
        let _ = Command::new("/usr/bin/git").current_dir(&fixture.project).args(["config", "--unset", key]).status();
    }
    for (key, value) in saved {
        if let Some(value) = value { std::env::set_var(key, value); } else { std::env::remove_var(key); }
    }
}
