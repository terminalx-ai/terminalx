//! Fresh-executable, single-main-thread supervisor controls. This target has no
//! libtest harness; every named case below runs explicitly and failures exit 1.
// The runtime's own module, as it ships: this target uses the launch and
// stop half; the handover half is the runtime's (`pty_handover.rs`).
#[cfg(target_os = "linux")]
#[path = "../../src/pty/supervisor.rs"]
#[allow(dead_code)]
mod supervisor;

#[cfg(not(target_os = "linux"))]
fn main() {
    println!("SKIP local_supervisor: Linux native controls require Linux; 0 native cases executed");
}

#[cfg(target_os = "linux")]
fn main() {
    // Must precede test controller threads, runtime/logger initialization, and
    // any owned fork. Owner launches a new executable, never a forked controller.
    if let Some(code) = supervisor::dispatch() { std::process::exit(code); }
    if std::env::args().nth(1).as_deref() == Some("--ancestry-child") {
        ancestry_child();
        return;
    }
    // The helper is always /proc/self/exe: this dispatcher, which handles
    // the private mode above (and from its ELF constructor before that).
    let cases: &[(&str, fn())] = &[
        ("helper_refuses_a_parent_that_is_another_program", helper_refuses_a_parent_that_is_another_program),
        ("native_non_sigchld_all_child_selection", native_non_sigchld_all_child_selection),
        ("native_clone_parent_adoption", native_clone_parent_adoption),
        ("native_nested_subreaper_adoption", native_nested_subreaper_adoption),
        ("native_multithreaded_leader_exit", native_multithreaded_leader_exit),
        ("omitted_candidates_retain_adopted_child", omitted_candidates_retain_adopted_child),
        ("preflight_loss_after_live_check_settles_and_retries", preflight_loss_after_live_check_settles_and_retries),
        ("sent_launch_loss_retains_ownership", sent_launch_loss_retains_ownership),
        ("uncertain_launch_loss_retains_ownership", uncertain_launch_loss_retains_ownership),
        ("live_exec_and_stop", live_exec_and_stop),
        ("unsolicited_immediate_shell_status", unsolicited_immediate_shell_status),
        ("killed_before_exec_pipe_read_is_not_started", killed_before_exec_pipe_read_is_not_started),
        ("bootstrap_timeout_then_signalled_cleanup_settles", bootstrap_timeout_then_signalled_cleanup_settles),
        ("failed_error_write_is_not_exec", failed_error_write_is_not_exec),
        ("immediate_zero_exit", immediate_zero_exit),
        ("injected_exiting_then_native_status", injected_exiting_then_native_status),
        ("injected_exiting_times_out", injected_exiting_times_out),
        ("stop_releases_injected_exit_hold", stop_releases_injected_exit_hold),
        ("timeout_then_late_exec_does_not_restart_bootstrap", timeout_then_late_exec_does_not_restart_bootstrap),
        ("injected_malformed_proc_refuses", injected_malformed_proc_refuses),
        ("injected_truncated_proc_refuses", injected_truncated_proc_refuses),
        ("injected_wrong_proc_pid_refuses", injected_wrong_proc_pid_refuses),
        ("injected_unavailable_proc_refuses", injected_unavailable_proc_refuses),
    ];
    let selected = std::env::args().nth(1);
    let cases: Vec<_> = cases.iter().filter(|(name, _)| selected.as_ref().is_none_or(|selected| selected == name)).collect();
    let mut passed = 0;
    for (name, test) in &cases {
        println!("RUN {name}");
        if std::panic::catch_unwind(*test).is_err() {
            eprintln!("FAIL {name}; {passed}/{} passed", cases.len());
            std::process::exit(1);
        }
        passed += 1;
        println!("PASS {name}");
    }
    assert!(!cases.is_empty(), "no registered native controls");
    println!("PASS local_supervisor: {passed}/{} native cases", cases.len());
}

#[cfg(target_os = "linux")]
fn master() -> std::os::fd::OwnedFd {
    use std::os::fd::FromRawFd;
    let fd = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC) };
    assert!(fd >= 0, "open PTY: {}", std::io::Error::last_os_error());
    let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
    use std::os::fd::AsRawFd;
    assert_eq!(unsafe { libc::grantpt(fd.as_raw_fd()) }, 0);
    assert_eq!(unsafe { libc::unlockpt(fd.as_raw_fd()) }, 0);
    fd
}

#[cfg(target_os = "linux")]
fn launch(command: &str) -> supervisor::Launch {
    let mut builder = supervisor::CommandBuilder::new("/bin/sh");
    builder.arg("-c").arg(command);
    builder.cwd("/tmp");
    builder.launch().unwrap().0
}

#[cfg(target_os = "linux")]
fn settled(owner: &supervisor::Owner) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while owner.pending() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!owner.pending(), "exact launch did not obtain a current extinction proof");
    assert!(owner.pid().is_none());
}

#[cfg(target_os = "linux")]
fn live_exec_and_stop() {
    use std::os::fd::AsRawFd;
    let master = master();
    let owner = supervisor::Owner::reserve();
    assert!(owner.reserved(), "fresh owner must expose its no-child reservation");
    let pid = owner.bootstrap(master.as_raw_fd(), launch("exec sleep 20")).unwrap();
    assert!(!owner.reserved(), "bootstrapped owner must close reservation admission");
    assert_eq!(owner.pid(), Some(pid));
    assert!(owner.attach_allowed());
    assert!(owner.pending());
    owner.stop();
    settled(&owner);
}

#[cfg(target_os = "linux")]
fn unsolicited_immediate_shell_status() {
    use std::os::fd::AsRawFd;
    let master = master();
    let owner = supervisor::Owner::reserve();
    owner.bootstrap(master.as_raw_fd(), launch("exit 37")).unwrap();
    // No observe/stop/request is sent by this test after the launch. The worker
    // receives the unsolicited ShellExit and subsequently closes empty admission.
    settled(&owner);
    let status = owner.wait_shell().expect("missing original shell status");
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 37);
}

#[cfg(target_os = "linux")]
fn killed_before_exec_pipe_read_is_not_started() {
    use std::os::fd::AsRawFd;
    let master = master();
    let owner = supervisor::Owner::reserve();
    std::env::set_var("TX467_SUPERVISOR_FAULT", "kill-before-eof");
    let result = owner.bootstrap(master.as_raw_fd(), launch("exit 0"));
    std::env::remove_var("TX467_SUPERVISOR_FAULT");
    owner.stop();
    settled(&owner);
    assert!(result.as_ref().is_err_and(|error| error.to_string().contains("exec interrupted")), "killed pre-exec child returned {result:?}");
    assert!(!owner.attach_allowed());
}

#[cfg(target_os = "linux")]
fn bootstrap_timeout_then_signalled_cleanup_settles() {
    use std::os::fd::AsRawFd;
    let master = master();
    let owner = supervisor::Owner::reserve();
    std::env::set_var("TX467_SUPERVISOR_FAULT", "timeout-before-exec");
    let result = owner.bootstrap(master.as_raw_fd(), launch("exit 0"));
    std::env::remove_var("TX467_SUPERVISOR_FAULT");
    assert!(result.as_ref().is_err_and(|error| error.to_string().contains("bootstrap timeout")), "expected timeout, got {result:?}");
    owner.stop();
    settled(&owner);
    assert!(!owner.attach_allowed());
}

#[cfg(target_os = "linux")]
fn failed_error_write_is_not_exec() {
    use std::os::fd::AsRawFd;
    let master = master();
    let owner = supervisor::Owner::reserve();
    std::env::set_var("TX467_SUPERVISOR_FAULT", "failed-error-write");
    let result = owner.bootstrap(master.as_raw_fd(), launch("exit 0"));
    std::env::remove_var("TX467_SUPERVISOR_FAULT");
    owner.stop();
    settled(&owner);
    assert!(result.as_ref().is_err_and(|error| error.to_string().contains("exec interrupted")), "failed child error record returned {result:?}");
    assert!(!owner.attach_allowed());
}

#[cfg(target_os = "linux")]
fn fault_refuses(mode: &str, expected: &str) {
    use std::os::fd::AsRawFd;
    let master = master();
    let owner = supervisor::Owner::reserve();
    std::env::set_var("TX467_SUPERVISOR_FAULT", mode);
    let result = owner.bootstrap(master.as_raw_fd(), launch("exec sleep 20"));
    std::env::remove_var("TX467_SUPERVISOR_FAULT");
    owner.stop();
    settled(&owner);
    assert!(result.as_ref().is_err_and(|error| error.to_string().contains(expected)), "fault {mode}: {result:?}");
    assert!(!owner.attach_allowed());
}
#[cfg(target_os = "linux")]
fn immediate_zero_exit() {
    use std::os::fd::AsRawFd;
    let master = master();
    let owner = supervisor::Owner::reserve();
    owner.bootstrap(master.as_raw_fd(), launch("exit 0")).unwrap();
    settled(&owner);
    assert_eq!(owner.wait_shell(), Some(0));
}
#[cfg(target_os = "linux")]
fn injected_exiting_then_native_status() {
    std::env::set_var("TX467_SUPERVISOR_FAULT", "exiting-once");
    unsolicited_immediate_shell_status();
    std::env::remove_var("TX467_SUPERVISOR_FAULT");
}
#[cfg(target_os = "linux")]
fn injected_exiting_times_out() { fault_refuses("exiting-timeout", "bootstrap timeout"); }
#[cfg(target_os = "linux")]
fn timeout_then_late_exec_does_not_restart_bootstrap() { fault_refuses("timeout-late-exec", "bootstrap timeout"); }
#[cfg(target_os = "linux")]
fn injected_malformed_proc_refuses() { fault_refuses("proc-malformed", "exec interrupted or unconfirmed"); }
#[cfg(target_os = "linux")]
fn injected_truncated_proc_refuses() { fault_refuses("proc-truncated", "exec interrupted or unconfirmed"); }
#[cfg(target_os = "linux")]
fn injected_wrong_proc_pid_refuses() { fault_refuses("proc-wrong-pid", "exec interrupted or unconfirmed"); }
#[cfg(target_os = "linux")]
fn injected_unavailable_proc_refuses() { fault_refuses("proc-unavailable", "exec interrupted or unconfirmed"); }
#[cfg(target_os = "linux")]
fn stop_releases_injected_exit_hold() {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::DirBuilderExt;
    let root = std::env::temp_dir().join(format!("tx467-exit-observation-{}", uuid::Uuid::new_v4()));
    std::fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let marker = root.join("observed");
    std::env::set_var("TX467_EXIT_OBSERVED", &marker);
    std::env::set_var("TX467_SUPERVISOR_FAULT", "exiting-stop");
    let owner = supervisor::Owner::reserve();
    let worker_owner = owner.clone();
    let worker = std::thread::spawn(move || {
        let master = master();
        worker_owner.bootstrap(master.as_raw_fd(), launch("exec sleep 20"))
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !marker.is_file() && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(10)); }
    assert!(marker.is_file(), "helper did not enter injected exit hold");
    owner.stop();
    settled(&owner);
    let result = worker.join().unwrap();
    assert!(result.as_ref().is_err_and(|error| error.to_string().contains("cancelled")), "Stop while held: {result:?}");
    std::env::remove_var("TX467_EXIT_OBSERVED");
    std::env::remove_var("TX467_SUPERVISOR_FAULT");
    std::fs::remove_file(marker).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[cfg(target_os = "linux")]
fn reaped(owner: &supervisor::Owner) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while !owner.observer_reaped() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(owner.observer_reaped(), "exact helper observer did not complete its reap");
}

#[cfg(target_os = "linux")]
fn preflight_loss_after_live_check_settles_and_retries() {
    use std::os::fd::AsRawFd;
    let marker = std::env::temp_dir().join(format!("tx467-h1-{}", uuid::Uuid::new_v4()));
    std::env::set_var("TX467_H1_PARENT_LIVE", &marker);
    std::env::set_var("TX467_SUPERVISOR_FAULT", "preflight-after-live-check");
    let master = master();
    let owner = supervisor::Owner::reserve();
    let result = owner.bootstrap(master.as_raw_fd(), launch("exit 0"));
    reaped(&owner);
    std::env::remove_var("TX467_SUPERVISOR_FAULT");
    std::env::remove_var("TX467_H1_PARENT_LIVE");
    assert!(marker.exists(), "helper never reached the live-check barrier");
    std::fs::remove_file(marker).unwrap();
    assert!(result.as_ref().is_err_and(|error| error.to_string().contains("injected preflight")), "boot reason lost: {result:?}");
    owner.stop();
    settled(&owner);
    assert!(!owner.attach_allowed());
    // The failed exact owner is settled, not reused. A subsequent independent
    // launch must bootstrap and stop normally with no stale channel/claim.
    live_exec_and_stop();
}

#[cfg(target_os = "linux")]
fn lost_launch_retains(mode: &str) {
    use std::os::fd::AsRawFd;
    std::env::set_var("TX467_SUPERVISOR_FAULT", mode);
    let master = master();
    let owner = supervisor::Owner::reserve();
    let result = owner.bootstrap(master.as_raw_fd(), launch("exit 0"));
    reaped(&owner);
    std::env::remove_var("TX467_SUPERVISOR_FAULT");
    assert!(result.is_err(), "lost helper accepted bootstrap: {result:?}");
    assert!(owner.pending(), "possibly delivered Launch lost retained ownership");
    assert!(!owner.attach_allowed());
    owner.stop();
    assert!(owner.pending(), "Stop cannot certify loss of a possibly launched witness");
    // This private seam exits before fork. The actual helper has been reaped;
    // retaining logical uncertainty here leaves no OS fixture process behind.
}
#[cfg(target_os = "linux")]
fn sent_launch_loss_retains_ownership() { lost_launch_retains("sent-launch-loss"); }
#[cfg(target_os = "linux")]
fn uncertain_launch_loss_retains_ownership() { lost_launch_retains("uncertain-launch-loss"); }

#[cfg(target_os = "linux")]
mod ancestry {
    use std::path::{Path, PathBuf};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::time::{Duration, Instant};

    pub fn until(what: &str, mut test: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(4);
        while !test() {
            assert!(Instant::now() < deadline, "ancestry timeout: {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub fn marker(root: &Path, name: &str) {
        let ids = unsafe { [libc::getpid(), libc::getppid(), libc::syscall(libc::SYS_gettid) as i32] };
        let tmp = root.join(format!("{name}.tmp-{}", ids[2]));
        std::fs::write(&tmp, format!("{} {} {}", ids[0], ids[1], ids[2])).unwrap();
        std::fs::rename(tmp, root.join(name)).unwrap();
    }
    pub fn ids(root: &Path, name: &str) -> Vec<i32> {
        let file = root.join(name);
        until(name, || file.exists());
        std::fs::read_to_string(file).unwrap().split_whitespace().map(|v| v.parse().unwrap()).collect()
    }
    pub fn parent(pid: i32) -> Option<i32> {
        std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?.lines()
            .find_map(|line| line.strip_prefix("PPid:").and_then(|v| v.trim().parse().ok()))
    }
    pub fn hold(root: &Path, name: &str) -> ! {
        unsafe { libc::signal(libc::SIGHUP, libc::SIG_IGN); libc::signal(libc::SIGTERM, libc::SIG_IGN); }
        marker(root, name);
        loop { unsafe { libc::pause(); } }
    }
    pub struct Process(pub OwnedFd);
    impl Process {
        pub fn open(pid: i32) -> Self {
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            assert!(fd >= 0, "pidfd for live fixture {pid}: {}", std::io::Error::last_os_error());
            Self(unsafe { OwnedFd::from_raw_fd(fd as i32) })
        }
        pub fn alive(&self) -> bool {
            let mut p = libc::pollfd { fd: self.0.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            let result = unsafe { libc::poll(&mut p, 1, 0) };
            assert!(result >= 0, "pidfd poll failed");
            result == 0
        }
    }
    impl Drop for Process {
        fn drop(&mut self) {
            // Exact pidfd cleanup also runs for the intentionally failing old
            // selector control. Never signal a recycled numeric PID.
            unsafe { libc::syscall(libc::SYS_pidfd_send_signal, self.0.as_raw_fd(), libc::SIGKILL, std::ptr::null::<libc::siginfo_t>(), 0); }
            let mut p = libc::pollfd { fd: self.0.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            unsafe { libc::poll(&mut p, 1, 2000); }
        }
    }
    pub struct Unrelated(pub std::process::Child);
    impl Unrelated {
        pub fn new() -> Self { Self(std::process::Command::new("/bin/sleep").arg("60").spawn().unwrap()) }
        pub fn check(&mut self) { assert!(self.0.try_wait().unwrap().is_none(), "unrelated direct child was stopped"); }
    }
    impl Drop for Unrelated {
        fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
    }
    pub fn fixture(mode: &str, root: &Path) -> super::supervisor::Launch {
        let mut command = super::supervisor::CommandBuilder::new(std::env::current_exe().unwrap());
        command.arg("--ancestry-child").arg(mode).arg(root);
        command.cwd("/tmp");
        command.launch().unwrap().0
    }
    pub fn root() -> PathBuf {
        use std::os::unix::fs::DirBuilderExt;
        let path = std::env::temp_dir().join(format!("tx467-ancestry-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new().mode(0o700).create(&path).unwrap(); path
    }
}

// Invoked as the normal PTY executable in a fresh process, before controller
// threads. No fork is performed by the threaded test controller.
#[cfg(target_os = "linux")]
fn ancestry_child() {
    use ancestry::*;
    let args: Vec<_> = std::env::args().collect();
    let mode = &args[2]; let root = std::path::Path::new(&args[3]);
    assert_eq!(std::fs::read_dir("/proc/self/task").unwrap().count(), 1);
    marker(root, "shell");
    extern "C" fn cloned(arg: *mut libc::c_void) -> libc::c_int {
        let root = unsafe { &*arg.cast::<std::path::PathBuf>() };
        hold(root, "child")
    }
    match mode.as_str() {
        "clone-parent" => {
            let mut path = root.to_path_buf(); let mut stack = vec![0u128; 65536];
            let pid = unsafe { libc::clone(cloned, stack.as_mut_ptr().add(stack.len()).cast(), libc::CLONE_PARENT | libc::SIGCHLD, (&mut path as *mut std::path::PathBuf).cast()) };
            assert!(pid > 0); assert_eq!(ids(root, "child")[0], pid);
            until("release clone parent", || root.join("release").exists());
        }
        "orphan" => {
            let pid = unsafe { libc::fork() }; assert!(pid >= 0);
            if pid == 0 { hold(root, "child"); }
            assert_eq!(ids(root, "child")[0], pid);
            until("release orphan parent", || root.join("release").exists());
        }
        "nested" => {
            assert_eq!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) }, 0);
            let middle = unsafe { libc::fork() }; assert!(middle >= 0);
            if middle == 0 {
                let child = unsafe { libc::fork() }; assert!(child >= 0);
                if child == 0 { hold(root, "child"); }
                assert_eq!(ids(root, "child")[0], child);
                unsafe { libc::_exit(0); }
            }
            let mut status = 0; assert_eq!(unsafe { libc::waitpid(middle, &mut status, 0) }, middle);
            assert_eq!(status, 0);
            marker(root, "nested-adopted");
            until("release nested subreaper", || root.join("release").exists());
        }
        "threads" => {
            let worker_root = root.to_path_buf();
            std::thread::spawn(move || hold(&worker_root, "worker"));
            let worker = ids(root, "worker"); assert_ne!(worker[0], worker[2]);
            // End only the main Linux thread, leaving the same process and
            // a live worker. No fork follows thread creation.
            unsafe { libc::syscall(libc::SYS_exit, 0); }
            unreachable!();
        }
        _ => panic!("unknown ancestry fixture"),
    }
}

/// The helper supervises only for this same program. Here its parent is a
/// shell, which also made the channel, so every descriptor check passes and
/// only the parent's image differs: the helper must refuse (exit 125)
/// before preflight, and fork nothing.
#[cfg(target_os = "linux")]
fn helper_refuses_a_parent_that_is_another_program() {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let master = master();
    let name = unsafe { std::ffi::CStr::from_ptr(libc::ptsname(master.as_raw_fd())) }.to_owned();
    let slave = unsafe { libc::open(name.as_ptr(), libc::O_RDWR | libc::O_NOCTTY) };
    assert!(slave >= 0, "open PTY slave: {}", std::io::Error::last_os_error());
    let mut command = std::process::Command::new("/bin/sh");
    // `; echo` keeps the shell from exec'ing the helper: the shell stays
    // its parent, and says how it exited.
    command.arg("-c").arg("\"$0\" __terminalx-private-pty-supervisor-v1 \"$1\" 5<&-; echo status=$?")
        .arg(std::env::current_exe().unwrap()).arg(uuid::Uuid::new_v4().to_string())
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    unsafe {
        command.pre_exec(move || {
            // Made here, in the shell's own process before it execs, so the
            // channel's peer is the helper's parent, as the runtime's is.
            let mut pair = [-1; 2];
            if libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET, 0, pair.as_mut_ptr()) < 0
                || libc::dup2(pair[1], 3) < 0 || libc::dup2(slave, 4) < 0 || libc::dup2(pair[0], 5) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    unsafe { libc::close(slave); }
    let said = String::from_utf8_lossy(&output.stdout);
    assert_eq!(said.trim(), "status=125", "the helper did not refuse its parent for its image: {said}");
}

#[cfg(target_os = "linux")]
fn native_non_sigchld_all_child_selection() {
    use ancestry::*; use std::os::fd::AsRawFd;
    let root = root(); let marker = root.join("clone");
    std::env::set_var("TX467_NONEXEC_CLONE_READY", &marker);
    let mut unrelated = Unrelated::new();
    let master = master(); let owner = supervisor::Owner::reserve();
    owner.bootstrap(master.as_raw_fd(), launch("exit 0")).unwrap();
    std::env::remove_var("TX467_NONEXEC_CLONE_READY");
    let child = ids(&root, "clone"); let child_fd = Process::open(child[0]);
    assert_eq!(parent(child[0]), Some(child[1]));
    assert_eq!(owner.wait_shell(), Some(0));
    // The private helper logged default wait=ECHILD while this clone was live.
    // Restoring only drain's old selector must fail this retained-owner control.
    let retained = owner.pending(); let alive = child_fd.alive();
    println!("ANCESTRY nonSIGCHLD child={} helper={} owner_pending={retained} child_live={alive}", child[0], child[1]);
    assert!(retained && alive, "all-child ownership disappeared with a live non-SIGCHLD clone");
    owner.stop(); settled(&owner); reaped(&owner);
    assert!(!child_fd.alive()); unrelated.check();
    drop(child_fd); drop(unrelated); std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
fn native_clone_parent_adoption() { adoption_case("clone-parent", false); }
#[cfg(target_os = "linux")]
fn native_nested_subreaper_adoption() { adoption_case("nested", false); }
#[cfg(target_os = "linux")]
fn omitted_candidates_retain_adopted_child() { adoption_case("orphan", true); }

#[cfg(target_os = "linux")]
fn adoption_case(mode: &str, omit: bool) {
    use ancestry::*; use std::os::fd::AsRawFd;
    let root = root(); let omission = root.join("omit");
    if omit { std::fs::write(&omission, b"discovery fault only").unwrap(); std::env::set_var("TX467_ANCESTRY_OMIT", &omission); }
    let mut unrelated = Unrelated::new();
    let master = master(); let owner = supervisor::Owner::reserve();
    let shell = owner.bootstrap(master.as_raw_fd(), fixture(mode, &root)).unwrap() as i32;
    std::env::remove_var("TX467_ANCESTRY_OMIT");
    let shell_fd = Process::open(shell); let original = ids(&root, "shell"); assert_eq!(original[0], shell);
    let child = ids(&root, "child"); let child_fd = Process::open(child[0]);
    if mode == "nested" { ids(&root, "nested-adopted"); until("nested adoption", || parent(child[0]) == Some(shell)); }
    if mode == "clone-parent" { assert_eq!(parent(child[0]), Some(original[1])); }
    std::fs::write(root.join("release"), b"exit original shell").unwrap();
    assert_eq!(owner.wait_shell(), Some(0));
    until("helper adoption", || parent(child[0]) == Some(original[1]));
    assert!(owner.pending() && child_fd.alive());
    println!("ANCESTRY {mode} shell={shell} child={} adopted_by={}", child[0], original[1]);
    owner.stop();
    if omit {
        // Wait past the helper's actual Unconfirmed response budget. Observe
        // that response via a private state accessor, not elapsed time alone.
        until("unconfirmed omission", || owner.test_unconfirmed());
        assert!(owner.pending() && child_fd.alive(), "empty candidate list certified extinction");
        println!("ANCESTRY omission unconfirmed=true child_live=true");
        std::fs::remove_file(omission).unwrap(); owner.stop();
    }
    settled(&owner); reaped(&owner);
    assert!(!child_fd.alive() && !shell_fd.alive()); unrelated.check();
    drop(child_fd); drop(shell_fd); drop(unrelated); std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
fn native_multithreaded_leader_exit() {
    use ancestry::*; use std::os::fd::AsRawFd;
    let root = root(); let mut unrelated = Unrelated::new();
    let master = master(); let owner = supervisor::Owner::reserve();
    let shell = owner.bootstrap(master.as_raw_fd(), fixture("threads", &root)).unwrap() as i32;
    let shell_fd = Process::open(shell); let worker = ids(&root, "worker"); assert_eq!(worker[0], shell); assert_ne!(worker[2], shell);
    until("leader zombie with live worker", || {
        std::fs::read_to_string(format!("/proc/{shell}/stat")).ok().is_some_and(|s| s.rsplit_once(')').unwrap().1.trim_start().starts_with('Z'))
    });
    assert!(std::path::Path::new(&format!("/proc/{shell}/task/{}", worker[2])).exists());
    assert!(owner.pending() && shell_fd.alive());
    println!("ANCESTRY leader={shell} state=Z live_worker={}", worker[2]);
    owner.stop(); settled(&owner); reaped(&owner);
    assert!(!shell_fd.alive()); unrelated.check();
    drop(shell_fd); drop(unrelated); std::fs::remove_dir_all(root).unwrap();
}
