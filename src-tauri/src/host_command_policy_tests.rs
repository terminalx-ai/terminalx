use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Barrier;

fn origin() -> Origin {
    Origin {
        mac: "mac-a".into(),
        account: "account-a".into(),
        organization: "org-a".into(),
        workspace: "workspace-a".into(),
        tab: "tab-a".into(),
        turn: "turn-a".into(),
    }
}

fn context() -> TrustedContext {
    TrustedContext {
        enabled: Some(true),
        local_mac: Some("mac-a".into()),
        local_account: Some("account-a".into()),
        origin: Some(origin()),
        generation: Some(1),
        approval_revision: Some(1),
        can_approve: Some(true),
        turn_active: Some(true),
        cwd_root: Some("/private/tmp".into()),
    }
}

fn input(id: &str) -> RequestInput {
    RequestInput {
        id: id.into(),
        origin: origin(),
        generation: 1,
        approval_revision: 1,
        issued_at_ms: 10,
        expires_at_ms: 100,
        executable: "/usr/bin/printf".into(),
        arguments: vec!["%s".into(), "literal ; $(text)\n\u{202e}".into()],
        cwd: "/private/tmp".into(),
        timeout_ms: 1000,
        output_limit_bytes: 4096,
    }
}

fn policy_with_context(context: TrustedContext) -> Policy {
    let policy = Policy {
        test_clock: Some(Arc::new(AtomicU64::new(10))),
        ..Policy::default()
    };
    policy.update_trusted_context(context).unwrap();
    policy
}

fn policy() -> Policy {
    policy_with_context(context())
}

fn set_time(policy: &Policy, time: u64) {
    policy
        .test_clock
        .as_ref()
        .unwrap()
        .store(time, Ordering::Relaxed);
}

#[test]
fn default_and_unknown_authority_deny_admission() {
    assert_eq!(
        Policy::default().submit(input("one")).err(),
        Some(Rejection::ContextUnavailable)
    );
    let mutations: &[fn(&mut TrustedContext)] = &[
        |c| c.enabled = None,
        |c| c.enabled = Some(false),
        |c| c.can_approve = None,
        |c| c.can_approve = Some(false),
        |c| c.turn_active = None,
        |c| c.turn_active = Some(false),
        |c| c.local_mac = None,
        |c| c.local_account = None,
        |c| c.origin = None,
        |c| c.generation = None,
        |c| c.generation = Some(0),
        |c| c.approval_revision = None,
        |c| c.approval_revision = Some(0),
        |c| c.cwd_root = None,
        |c| c.cwd_root = Some("/".into()),
        |c| c.local_mac = Some(String::new()),
        |c| c.origin.as_mut().unwrap().tab.clear(),
    ];
    for mutate in mutations {
        let mut c = context();
        mutate(&mut c);
        assert_eq!(
            policy_with_context(c).submit(input("one")).err(),
            Some(Rejection::ContextUnavailable)
        );
    }
}

#[test]
fn exact_authoritative_turn_device_account_and_rights() {
    let mutations: &[fn(&mut RequestInput)] = &[
        |i| i.origin.mac = "mac-b".into(),
        |i| i.origin.account = "account-b".into(),
        |i| i.origin.organization = "org-b".into(),
        |i| i.origin.workspace = "workspace-b".into(),
        |i| i.origin.tab = "tab-b".into(),
        |i| i.origin.turn = "turn-b".into(),
        |i| i.generation = 2,
        |i| i.approval_revision = 2,
    ];
    for mutate in mutations {
        let mut proposal = input("one");
        mutate(&mut proposal);
        assert_eq!(
            policy().submit(proposal).err(),
            Some(Rejection::ContextMismatch)
        );
    }
    let mut wrong_local_device = context();
    wrong_local_device.local_mac = Some("mac-b".into());
    assert_eq!(
        policy_with_context(wrong_local_device)
            .submit(input("one"))
            .err(),
        Some(Rejection::ContextMismatch)
    );
    let mut wrong_local_account = context();
    wrong_local_account.local_account = Some("account-b".into());
    assert_eq!(
        policy_with_context(wrong_local_account)
            .submit(input("one"))
            .err(),
        Some(Rejection::ContextMismatch)
    );
}

#[test]
fn malformed_and_bounded_requests_fail_closed() {
    let mutations: &[fn(&mut RequestInput)] = &[
        |i| i.id = "white space".into(),
        |i| i.id = "x".repeat(129),
        |i| i.origin.turn.clear(),
        |i| i.generation = 0,
        |i| i.approval_revision = 0,
        |i| i.executable = "printf".into(),
        |i| i.executable.push('\0'),
        |i| i.cwd = "/private/tmp/..".into(),
        |i| i.cwd = "/private//tmp".into(),
        |i| i.cwd = format!("/{}", "x".repeat(4096)),
        |i| i.arguments = vec![String::new(); MAX_ARGUMENTS + 1],
        |i| i.arguments.push("\0".into()),
        |i| i.arguments = vec!["x".repeat(8193)],
        |i| i.arguments = vec!["x".repeat(8192); 5],
        |i| i.expires_at_ms = i.issued_at_ms,
        |i| i.expires_at_ms = i.issued_at_ms - 1,
        |i| i.expires_at_ms = i.issued_at_ms + MAX_TTL_MS + 1,
        |i| i.timeout_ms = 0,
        |i| i.timeout_ms = MAX_TIMEOUT_MS + 1,
        |i| i.output_limit_bytes = 0,
        |i| i.output_limit_bytes = MAX_OUTPUT_BYTES + 1,
    ];
    for mutate in mutations {
        let mut proposal = input("one");
        mutate(&mut proposal);
        assert_eq!(
            policy().submit(proposal).err(),
            Some(Rejection::InvalidRequest)
        );
    }
    let mut proposal = input("one");
    proposal.cwd = "/private/tmp-lookalike".into();
    assert_eq!(
        policy().submit(proposal).err(),
        Some(Rejection::InvalidDirectory)
    );
}

#[test]
fn proposal_is_immutable_and_expiry_releases_slot_without_enabling_replay() {
    let policy = policy();
    let mut proposal = input("one");
    proposal.arguments.push(String::new());
    proposal.timeout_ms = MAX_TIMEOUT_MS;
    proposal.output_limit_bytes = MAX_OUTPUT_BYTES;
    let request = policy.submit(proposal.clone()).unwrap();
    proposal.arguments.clear();
    assert_eq!(
        request.input().arguments,
        input("one")
            .arguments
            .into_iter()
            .chain([String::new()])
            .collect::<Vec<_>>()
    );

    set_time(&policy, 100);
    assert_eq!(request.state(), Ok(State::Expired));
    assert_eq!(policy.submit(input("one")).err(), Some(Rejection::Replay));
    let mut next = input("two");
    next.issued_at_ms = 100;
    next.expires_at_ms = 100 + MAX_TTL_MS;
    assert!(policy.submit(next).is_ok());
}

#[test]
fn bounded_registry_refuses_new_ids_and_replay_when_full() {
    let policy = policy();
    for id in 0..MAX_REQUESTS {
        assert_eq!(
            policy
                .submit(input(&format!("request-{id}")))
                .unwrap()
                .cancel(),
            Ok(State::Cancelled)
        );
    }
    assert_eq!(policy.submit(input("new")).err(), Some(Rejection::Capacity));
    assert_eq!(
        policy.submit(input("request-0")).err(),
        Some(Rejection::Replay)
    );
}

#[test]
fn concurrent_submissions_share_one_registry() {
    for same_id in [false, true] {
        let policy = policy();
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|id| {
                let policy = policy.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    let id = if same_id {
                        "same".into()
                    } else {
                        format!("id-{id}")
                    };
                    barrier.wait();
                    policy.submit(input(&id)).map(|_| ())
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        let error = if same_id {
            Rejection::Replay
        } else {
            Rejection::Busy
        };
        assert_eq!(results.iter().filter(|r| **r == Err(error)).count(), 7);
    }
}

#[test]
fn poison_fails_closed() {
    let policy = policy();
    let shared = policy.shared.clone();
    assert!(thread::spawn(move || {
        let _guard = shared.lock().unwrap();
        panic!("simulated panic");
    })
    .join()
    .is_err());
    assert_eq!(policy.submit(input("one")).err(), Some(Rejection::Poisoned));
    assert_eq!(
        policy.update_trusted_context(context()),
        Err(Rejection::Poisoned)
    );
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::PathBuf;
    use std::time::Duration;

    fn approve(policy: &Policy, request: &Request) {
        let binding = policy.prepare_local_decision(request).unwrap();
        assert_eq!(binding.input().arguments, request.input().arguments);
        assert_eq!(binding.input().cwd, request.input().cwd);
        assert_eq!(binding.input().executable, request.input().executable);
        assert_eq!(
            policy.record_local_decision(request, binding, LocalDecision::AllowOnce),
            Ok(State::Approved)
        );
    }

    fn approved(policy: &Policy, input: RequestInput) -> Request {
        let request = policy.submit(input).unwrap();
        approve(policy, &request);
        request
    }

    fn assert_stopped(execution: Execution, expected: State) {
        match execution.wait().unwrap() {
            ExecutionOutcome::Stopped(state) => assert_eq!(state, expected),
            ExecutionOutcome::Exited { .. } => panic!("unexpected command output"),
        }
    }

    fn output(execution: Execution) -> (Option<i32>, Option<i32>, Vec<u8>, Vec<u8>) {
        match execution.wait().unwrap() {
            ExecutionOutcome::Exited {
                code,
                signal,
                stdout,
                stderr,
            } => (code, signal, stdout, stderr),
            ExecutionOutcome::Stopped(state) => panic!("command stopped: {state:?}"),
        }
    }

    #[test]
    fn approval_denial_expiry_and_cross_request_binding() {
        let policy = policy();
        let request = policy.submit(input("one")).unwrap();
        assert_eq!(
            policy.start(&request).err(),
            Some(Rejection::InvalidTransition)
        );
        let denied = policy.prepare_local_decision(&request).unwrap();
        let duplicate = policy.prepare_local_decision(&request).unwrap();
        assert_eq!(
            policy.record_local_decision(&request, denied, LocalDecision::default()),
            Ok(State::Denied)
        );
        assert_eq!(
            policy.record_local_decision(&request, duplicate, LocalDecision::AllowOnce),
            Err(Rejection::InvalidTransition)
        );
        assert_eq!(
            policy.start(&request).err(),
            Some(Rejection::InvalidTransition)
        );

        let request = policy.submit(input("two")).unwrap();
        let binding = policy.prepare_local_decision(&request).unwrap();
        request.cancel().unwrap();
        let next = policy.submit(input("three")).unwrap();
        assert_eq!(
            policy.record_local_decision(&next, binding, LocalDecision::AllowOnce),
            Err(Rejection::DecisionMismatch)
        );
        assert_eq!(next.state(), Ok(State::Denied));

        let request = policy.submit(input("four")).unwrap();
        let foreign = super::policy();
        assert_eq!(
            foreign.start(&request).err(),
            Some(Rejection::DecisionMismatch)
        );
        let other = foreign.submit(input("four")).unwrap();
        let binding = foreign.prepare_local_decision(&other).unwrap();
        assert_eq!(
            policy.record_local_decision(&request, binding, LocalDecision::AllowOnce),
            Err(Rejection::DecisionMismatch)
        );

        let request = policy.submit(input("five")).unwrap();
        let late = policy.prepare_local_decision(&request).unwrap();
        set_time(&policy, 100);
        assert_eq!(
            policy.record_local_decision(&request, late, LocalDecision::AllowOnce),
            Err(Rejection::Expired)
        );
        assert_eq!(request.state(), Ok(State::Expired));
    }

    #[test]
    fn exact_argv_and_single_use_across_concurrent_starts() {
        let policy = policy();
        let request = approved(&policy, input("one"));
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let policy = policy.clone();
                let request = request.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    policy.start(&request)
                })
            })
            .collect();
        let mut winners = Vec::new();
        for worker in threads {
            match worker.join().unwrap() {
                Ok(execution) => winners.push(execution),
                Err(reason) => assert_eq!(reason, Rejection::InvalidTransition),
            }
        }
        assert_eq!(winners.len(), 1);
        let (code, signal, stdout, stderr) = output(winners.pop().unwrap());
        assert_eq!(code, Some(0));
        assert_eq!(signal, None);
        assert_eq!(stdout, request.input().arguments[1].as_bytes());
        assert!(stderr.is_empty());
        assert_eq!(request.state(), Ok(State::Completed));
        assert_eq!(
            policy.start(&request).err(),
            Some(Rejection::InvalidTransition)
        );
        let mut changed = input("one");
        changed.arguments.push("changed".into());
        assert_eq!(policy.submit(changed).err(), Some(Rejection::Replay));
        assert!(policy.submit(input("two")).is_ok());
    }

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = PathBuf::from(format!(
                "/private/tmp/terminalx-pro220-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn apply(&self, proposal: &mut RequestInput) {
            proposal.cwd = self.0.to_str().unwrap().into();
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn shell(id: &str, script: &str) -> RequestInput {
        let mut proposal = input(id);
        proposal.executable = "/bin/sh".into();
        proposal.arguments = vec!["-c".into(), script.into()];
        proposal
    }

    #[test]
    fn context_cancel_and_expiry_win_at_the_actual_spawn_gate() {
        let cases: &[(State, fn(&Policy, &Request))] = &[
            (State::Cancelled, |_, r| {
                r.cancel().unwrap();
            }),
            (State::Expired, |p, _| set_time(p, 100)),
            (State::Revoked, |p, _| {
                p.update_trusted_context(TrustedContext::default()).unwrap()
            }),
            (State::Revoked, |p, _| {
                let mut c = context();
                c.local_mac = Some("mac-b".into());
                p.update_trusted_context(c).unwrap();
            }),
            (State::Revoked, |p, _| {
                let mut c = context();
                c.local_account = Some("account-b".into());
                p.update_trusted_context(c).unwrap();
                p.update_trusted_context(context()).unwrap();
            }),
            (State::Revoked, |p, _| {
                let mut c = context();
                c.origin.as_mut().unwrap().turn = "other-turn".into();
                p.update_trusted_context(c).unwrap();
            }),
            (State::Revoked, |p, _| {
                let mut c = context();
                c.approval_revision = Some(2);
                p.update_trusted_context(c).unwrap();
            }),
        ];
        for (expected, invalidate) in cases {
            let mut policy = policy();
            let hold = Arc::new(Barrier::new(2));
            let worker = hold.clone();
            policy.test_before_spawn = Some(Arc::new(move || {
                worker.wait();
                worker.wait();
            }));
            let directory = Directory::new();
            let mut proposal = shell("one", "printf spawned > spawn-marker");
            directory.apply(&mut proposal);
            let request = approved(&policy, proposal);
            let execution = policy.start(&request).unwrap();
            hold.wait();
            assert_eq!(request.state(), Ok(State::Starting));
            invalidate(&policy, &request);
            hold.wait();
            assert_stopped(execution, *expected);
            assert_eq!(request.state(), Ok(*expected));
            assert!(!directory.0.join("spawn-marker").exists());
        }
    }

    #[test]
    fn cwd_mapping_rejects_symlinks_and_replaced_directories() {
        let directory = Directory::new();
        let original = directory.0.join("original");
        let replaced = directory.0.join("replaced");
        let link = directory.0.join("alias");
        fs::create_dir(&original).unwrap();
        symlink(&original, &link).unwrap();

        let policy = policy();
        let mut proposal = input("alias");
        proposal.cwd = link.to_str().unwrap().into();
        let alias = policy.submit(proposal).unwrap();
        assert_eq!(
            policy.prepare_local_decision(&alias).err(),
            Some(Rejection::InvalidDirectory)
        );
        alias.cancel().unwrap();

        let mut proposal = shell("one", "printf spawned > spawn-marker");
        proposal.cwd = original.to_str().unwrap().into();
        let request = approved(&policy, proposal);
        fs::rename(&original, &replaced).unwrap();
        fs::create_dir(&original).unwrap();
        assert_stopped(policy.start(&request).unwrap(), State::SpawnFailed);
        assert!(!original.join("spawn-marker").exists());
        assert!(!replaced.join("spawn-marker").exists());
    }

    #[test]
    fn executable_replacement_or_symlink_is_rejected() {
        let directory = Directory::new();
        let program = directory.0.join("program");
        let old = directory.0.join("old");
        let policy = policy();
        fs::copy("/usr/bin/printf", &program).unwrap();
        let mut proposal = input("one");
        proposal.executable = program.to_str().unwrap().into();
        let request = approved(&policy, proposal);
        fs::rename(&program, &old).unwrap();
        symlink("/usr/bin/printf", &program).unwrap();
        assert_stopped(policy.start(&request).unwrap(), State::SpawnFailed);

        let mut proposal = input("two");
        proposal.executable = program.to_str().unwrap().into();
        let request = policy.submit(proposal).unwrap();
        assert_eq!(
            policy.prepare_local_decision(&request).err(),
            Some(Rejection::ExecutableUnavailable)
        );
        request.cancel().unwrap();

        fs::remove_file(&program).unwrap();
        fs::write(&program, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let mut proposal = input("three");
        directory.apply(&mut proposal);
        proposal.executable = program.to_str().unwrap().into();
        let request = approved(&policy, proposal);
        fs::write(&program, b"#!/bin/sh\nprintf spawned > spawn-marker\n").unwrap();
        assert_stopped(policy.start(&request).unwrap(), State::SpawnFailed);
        assert!(!directory.0.join("spawn-marker").exists());
    }

    #[test]
    fn bad_executable_has_no_implicit_shell_fallback() {
        let directory = Directory::new();
        let program = directory.0.join("invalid-program");
        fs::write(&program, b"printf spawned > spawn-marker\n").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let mut proposal = input("one");
        directory.apply(&mut proposal);
        proposal.executable = program.to_str().unwrap().into();
        let policy = policy();
        let request = approved(&policy, proposal);
        assert_stopped(policy.start(&request).unwrap(), State::SpawnFailed);
        assert!(!directory.0.join("spawn-marker").exists());
        assert_eq!(
            policy.start(&request).err(),
            Some(Rejection::InvalidTransition)
        );
    }

    #[test]
    fn empty_environment_closed_stdin_no_inherited_fds_and_anchored_cwd() {
        let directory = Directory::new();
        let policy = policy();
        let mut env = input("env");
        env.executable = "/usr/bin/env".into();
        env.arguments.clear();
        let (_, _, stdout, stderr) = output(policy.start(&approved(&policy, env)).unwrap());
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());

        // F_DUPFD creates a deliberately inheritable descriptor. The child must not see it.
        unsafe extern "C" {
            fn fcntl(fd: i32, cmd: i32, ...) -> i32;
        }
        let mut file = fs::File::create(directory.0.join("local-fixture")).unwrap();
        file.write_all(b"synthetic fixture").unwrap();
        let fd = unsafe { fcntl(file.as_raw_fd(), 0, 200i32) };
        assert!(fd >= 200);
        let inherited = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut proposal = shell("stdio", "if read -r ignored || [ -e /dev/fd/\"$1\" ]; then exit 9; fi; /bin/pwd -P; printf '\\377' >&2");
        directory.apply(&mut proposal);
        proposal.arguments.extend(["test".into(), fd.to_string()]);
        let (code, signal, stdout, stderr) =
            output(policy.start(&approved(&policy, proposal)).unwrap());
        drop(inherited);
        assert_eq!((code, signal), (Some(0), None));
        assert_eq!(stdout, format!("{}\n", directory.0.display()).as_bytes());
        assert_eq!(stderr, [0xff]);
    }

    #[test]
    fn exact_combined_output_limit_and_typed_exit_status() {
        let policy = policy();
        let mut proposal = shell("one", "printf abc; printf def >&2; exit 7");
        proposal.output_limit_bytes = 6;
        let (code, signal, stdout, stderr) =
            output(policy.start(&approved(&policy, proposal.clone())).unwrap());
        assert_eq!((code, signal), (Some(7), None));
        assert_eq!(stdout, b"abc");
        assert_eq!(stderr, b"def");
        proposal.id = "two".into();
        proposal.output_limit_bytes = 5;
        assert_stopped(
            policy.start(&approved(&policy, proposal)).unwrap(),
            State::OutputLimitExceeded,
        );

        let mut proposal = input("three");
        proposal.executable = "/usr/bin/head".into();
        proposal.arguments = vec!["-c".into(), "65536".into(), "/dev/zero".into()];
        proposal.output_limit_bytes = 32;
        assert_stopped(
            policy.start(&approved(&policy, proposal)).unwrap(),
            State::OutputLimitExceeded,
        );
    }

    #[test]
    fn cancelled_revoked_timed_out_and_orphaned_groups_do_not_finish_descendant_work() {
        let cases = [
            State::Cancelled,
            State::Revoked,
            State::Expired,
            State::TimedOut,
            State::Completed,
        ];
        for expected in cases {
            let directory = Directory::new();
            let mut policy = policy();
            let group_events = Arc::new(Mutex::new(Vec::new()));
            policy.test_group_events = Some(group_events.clone());
            let script = if expected == State::Completed {
                "(/bin/sleep 0.6; printf done > descendant-finished) & printf ready > ready"
            } else {
                "(/bin/sleep 0.6; printf done > descendant-finished) & printf ready > ready; wait"
            };
            let mut proposal = shell("one", script);
            directory.apply(&mut proposal);
            proposal.timeout_ms = if expected == State::TimedOut {
                250
            } else {
                2_000
            };
            let request = approved(&policy, proposal);
            let started = Instant::now();
            let execution = policy.start(&request).unwrap();
            let ready = directory.0.join("ready");
            while !ready.exists() && started.elapsed() < Duration::from_secs(2) {
                thread::sleep(Duration::from_millis(5));
            }
            assert!(ready.exists());
            match expected {
                State::Cancelled => {
                    request.cancel().unwrap();
                }
                State::Revoked => {
                    let mut switched = context();
                    switched.local_account = Some("new-account".into());
                    policy.update_trusted_context(switched).unwrap();
                }
                State::Expired => set_time(&policy, 100),
                _ => {}
            }
            if expected == State::Completed {
                assert_eq!(output(execution).0, Some(0));
            } else {
                assert_stopped(execution, expected);
            }
            assert!(started.elapsed() < Duration::from_millis(580));
            assert_eq!(request.state(), Ok(expected));
            thread::sleep(Duration::from_millis(650).saturating_sub(started.elapsed()));
            assert!(!directory.0.join("descendant-finished").exists());
            let events = group_events.lock().unwrap();
            let Some((executor::GroupEvent::Reaped(pid), signals)) = events.split_last() else {
                panic!("expected group cleanup to finish with reaping");
            };
            assert!(!signals.is_empty());
            assert!(signals
                .iter()
                .all(|event| *event == executor::GroupEvent::Signal(*pid)));
        }
    }

    #[test]
    fn output_handoff_fails_closed_after_away_and_back_context_change() {
        let policy = policy();
        let request = approved(&policy, input("one"));
        let execution = policy.start(&request).unwrap();
        let started = Instant::now();
        while request.state() == Ok(State::Running) || request.state() == Ok(State::Starting) {
            assert!(started.elapsed() < Duration::from_secs(2));
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(request.state(), Ok(State::Completed));
        policy
            .update_trusted_context(TrustedContext::default())
            .unwrap();
        policy.update_trusted_context(context()).unwrap();
        assert_stopped(execution, State::Revoked);
        assert_eq!(request.state(), Ok(State::Completed));
    }

    #[test]
    fn dropping_execution_cancels_it() {
        let policy = policy();
        let mut proposal = input("one");
        proposal.executable = "/bin/sleep".into();
        proposal.arguments = vec!["2".into()];
        let request = approved(&policy, proposal);
        let execution = policy.start(&request).unwrap();
        drop(execution);
        assert_eq!(request.state(), Ok(State::Cancelled));
        assert_eq!(
            policy.start(&request).err(),
            Some(Rejection::InvalidTransition)
        );
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn approval_fails_closed_on_unsupported_platforms() {
    let policy = policy();
    let request = policy.submit(input("one")).unwrap();
    assert_eq!(
        policy.prepare_local_decision(&request).err(),
        Some(Rejection::UnsupportedPlatform)
    );
    assert_eq!(
        policy.start(&request).err(),
        Some(Rejection::InvalidTransition)
    );
}
