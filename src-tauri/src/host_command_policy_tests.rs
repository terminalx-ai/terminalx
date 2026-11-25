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

pub(super) fn input(id: &str) -> RequestInput {
    RequestInput {
        id: id.into(),
        origin: origin(),
        generation: 1,
        approval_revision: 1,
        ttl_ms: 90,
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
        |i| i.ttl_ms = 0,
        |i| i.ttl_ms = MAX_TTL_MS + 1,
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
    assert_eq!(request.state(), Ok(State::ExpiredBeforeLaunch));
    assert_eq!(policy.submit(input("one")).err(), Some(Rejection::Replay));
    assert!(policy.submit(input("two")).is_ok());
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
fn expired_registry_releases_capacity_without_rebinding_old_handles() {
    let policy = policy();
    for index in 1..MAX_REQUESTS {
        policy
            .submit(input(&format!("old-{index}")))
            .unwrap()
            .cancel()
            .unwrap();
    }
    let old = policy.submit(input("reused")).unwrap();
    set_time(&policy, 10 + MAX_TTL_MS);
    let new = policy.submit(input("reused")).unwrap();
    assert_eq!(old.state(), Ok(State::ExpiredBeforeLaunch));
    assert_eq!(policy.start(&old).err(), Some(Rejection::Expired));
    assert_eq!(new.state(), Ok(State::Pending));
    assert_eq!(policy.lock().unwrap().entries.len(), 1);
}

#[test]
fn prompt_reservation_limits_parallel_and_repeated_attempts() {
    let policy = policy();
    let mut proposal = input("one");
    proposal.ttl_ms = MAX_TTL_MS;
    let request = policy.submit(proposal).unwrap();
    let slot = policy.reserve_prompt(&request).unwrap();
    assert_eq!(
        policy.reserve_prompt(&request).err(),
        Some(Rejection::PromptRateLimited)
    );
    drop(slot);
    for _ in 0..2 {
        drop(policy.reserve_prompt(&request).unwrap());
    }
    assert_eq!(
        policy.reserve_prompt(&request).err(),
        Some(Rejection::PromptRateLimited)
    );
    set_time(&policy, 10 + MAX_TTL_MS);
    let next = policy.submit(input("two")).unwrap();
    assert!(policy.reserve_prompt(&next).is_ok());
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
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::time::Duration;

    fn approve(policy: &Policy, request: &Request) {
        let binding = policy.prepare_local_decision(request).unwrap();
        assert_eq!(binding.input().arguments, request.input().arguments);
        assert_eq!(binding.input().cwd, request.input().cwd);
        assert_eq!(binding.input().executable, request.input().executable);
        assert_eq!(
            policy.record_local_decision(
                request,
                consent::Decision::fixture(binding, LocalDecision::AllowOnce)
            ),
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
            _ => panic!("unexpected sandboxed launch"),
        }
    }

    fn assert_withheld(execution: Execution, expected: State) -> (Option<i32>, Option<i32>) {
        match execution.wait().unwrap() {
            ExecutionOutcome::LaunchedWithOutputWithheld {
                code,
                signal,
                reason,
            } => {
                assert_eq!(reason, expected);
                (code, signal)
            }
            _ => panic!("expected a sandboxed launch with withheld output"),
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
            ExecutionOutcome::Stopped(state)
            | ExecutionOutcome::LaunchedWithOutputWithheld { reason: state, .. } => {
                panic!("command stopped: {state:?}")
            }
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
            policy.record_local_decision(
                &request,
                consent::Decision::fixture(denied, LocalDecision::default())
            ),
            Ok(State::Denied)
        );
        assert_eq!(
            policy.record_local_decision(
                &request,
                consent::Decision::fixture(duplicate, LocalDecision::AllowOnce)
            ),
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
            policy.record_local_decision(
                &next,
                consent::Decision::fixture(binding, LocalDecision::AllowOnce)
            ),
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
            policy.record_local_decision(
                &request,
                consent::Decision::fixture(binding, LocalDecision::AllowOnce)
            ),
            Err(Rejection::DecisionMismatch)
        );

        let request = policy.submit(input("five")).unwrap();
        let late = policy.prepare_local_decision(&request).unwrap();
        set_time(&policy, 100);
        assert_eq!(
            policy.record_local_decision(
                &request,
                consent::Decision::fixture(late, LocalDecision::AllowOnce)
            ),
            Err(Rejection::Expired)
        );
        assert_eq!(request.state(), Ok(State::ExpiredBeforeLaunch));
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

    #[test]
    fn context_cancel_and_expiry_win_at_the_actual_spawn_gate() {
        type BeforeSpawn = fn(&Policy, &Request);
        let cases: &[(State, BeforeSpawn)] = &[
            (State::Cancelled, |_, r| {
                r.cancel().unwrap();
            }),
            (State::ExpiredBeforeLaunch, |p, _| set_time(p, 100)),
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
            let mut proposal = input("one");
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

        let mut proposal = input("one");
        proposal.cwd = original.to_str().unwrap().into();
        let request = approved(&policy, proposal);
        fs::rename(&original, &replaced).unwrap();
        fs::create_dir(&original).unwrap();
        assert_stopped(policy.start(&request).unwrap(), State::SpawnFailed);
        assert!(!original.join("spawn-marker").exists());
        assert!(!replaced.join("spawn-marker").exists());
    }

    #[test]
    fn writable_executable_or_symlink_cannot_be_approved() {
        let directory = Directory::new();
        let program = directory.0.join("program");
        let link = directory.0.join("link");
        fs::copy("/usr/bin/printf", &program).unwrap();
        symlink("/usr/bin/printf", &link).unwrap();
        let policy = policy();

        for (id, executable) in [("writable", program), ("link", link)] {
            let mut proposal = input(id);
            proposal.executable = executable.to_str().unwrap().into();
            let request = policy.submit(proposal).unwrap();
            assert_eq!(
                policy.prepare_local_decision(&request).err(),
                Some(Rejection::ExecutableUnavailable)
            );
            request.cancel().unwrap();
        }
    }

    #[test]
    fn shell_startup_files_and_argument_options_are_refused() {
        const FIXTURE: &str = "PRO220_STARTUP_FIXTURE";
        if let Some(fixture) = std::env::var_os(FIXTURE) {
            run_startup_fixture(&PathBuf::from(fixture));
            return;
        }

        let directory = Directory::new();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("shell_startup_files_and_argument_options_are_refused")
            .env(FIXTURE, &directory.0)
            .env("HOME", &directory.0)
            .env("ZDOTDIR", &directory.0)
            .env("PATH", &directory.0)
            .env("DYLD_LIBRARY_PATH", &directory.0)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&result.stdout);
        assert!(
            result.status.success() && stdout.contains("1 passed"),
            "{stdout}"
        );
    }

    fn run_startup_fixture(directory: &std::path::Path) {
        let marker = directory.join("startup-marker");
        fs::write(
            directory.join(".zshenv"),
            format!("touch '{}'\n", marker.display()),
        )
        .unwrap();
        let policy = policy();
        for (id, program, args) in [
            ("shell", "/bin/zsh", vec!["-c", "true"]),
            ("environment", "/usr/bin/env", vec![]),
            ("format", "/usr/bin/printf", vec!["%b", "text"]),
            ("option", "/usr/bin/printf", vec!["--help"]),
            ("duration", "/bin/sleep", vec!["1e2"]),
        ] {
            let mut proposal = input(id);
            proposal.cwd = directory.to_str().unwrap().to_owned();
            proposal.executable = program.into();
            proposal.arguments = args.into_iter().map(str::to_owned).collect();
            let request = policy.submit(proposal).unwrap();
            assert_eq!(
                policy.prepare_local_decision(&request).err(),
                Some(Rejection::ExecutableUnavailable)
            );
            request.cancel().unwrap();
        }

        let mut proposal = input("literal");
        proposal.cwd = directory.to_str().unwrap().to_owned();
        proposal.arguments[1] = "DYLD_INSERT_LIBRARIES=fixture PATH=/fixture".into();
        let (_, _, stdout, _) = output(policy.start(&approved(&policy, proposal)).unwrap());
        assert_eq!(stdout, b"DYLD_INSERT_LIBRARIES=fixture PATH=/fixture");
        assert!(!marker.exists());
    }

    #[test]
    fn approval_text_escapes_controls_and_rejects_truncation() {
        let policy = policy();
        let mut proposal = input("one");
        let text = prompt_text(&proposal).unwrap();
        assert!(text.contains(r"\n\u{202e}"));
        assert!(!text.contains('\u{202e}'));
        proposal.arguments[1] = "x".repeat(1_024);
        let request = policy.submit(proposal).unwrap();
        assert_eq!(
            policy.prepare_local_decision(&request).err(),
            Some(Rejection::InvalidRequest)
        );
    }

    #[test]
    fn exact_output_limit_and_typed_exit_status() {
        let policy = policy();
        let mut proposal = input("one");
        proposal.arguments[1] = "abcdef".into();
        proposal.output_limit_bytes = 6;
        let (code, signal, stdout, stderr) =
            output(policy.start(&approved(&policy, proposal.clone())).unwrap());
        assert_eq!((code, signal), (Some(0), None));
        assert_eq!(stdout, b"abcdef");
        assert!(stderr.is_empty());
        proposal.id = "two".into();
        proposal.output_limit_bytes = 5;
        assert_withheld(
            policy.start(&approved(&policy, proposal)).unwrap(),
            State::OutputLimitExceeded,
        );

        let mut proposal = input("three");
        proposal.executable = "/usr/bin/false".into();
        proposal.arguments.clear();
        let (code, signal, _, _) = output(policy.start(&approved(&policy, proposal)).unwrap());
        assert_eq!((code, signal), (Some(1), None));
    }

    #[test]
    fn cancelled_revoked_expired_and_timed_out_processes_are_signalled_before_reaping() {
        for expected in [
            State::Cancelled,
            State::Revoked,
            State::ExpiredAfterLaunch,
            State::TimedOut,
        ] {
            let mut policy = policy();
            let group_events = Arc::new(Mutex::new(Vec::new()));
            policy.test_group_events = Some(group_events.clone());
            let mut proposal = input("one");
            proposal.executable = "/bin/sleep".into();
            proposal.arguments = vec!["2".into()];
            proposal.timeout_ms = if expected == State::TimedOut {
                500
            } else {
                2_000
            };
            let request = approved(&policy, proposal);
            let started = Instant::now();
            let execution = policy.start(&request).unwrap();
            while request.state() == Ok(State::Starting)
                && started.elapsed() < Duration::from_secs(2)
            {
                thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(request.state(), Ok(State::Running));
            match expected {
                State::Cancelled => {
                    request.cancel().unwrap();
                }
                State::Revoked => {
                    let mut switched = context();
                    switched.local_account = Some("new-account".into());
                    policy.update_trusted_context(switched).unwrap();
                }
                State::ExpiredAfterLaunch => set_time(&policy, 100),
                _ => {}
            }
            assert_withheld(execution, expected);
            assert_eq!(request.state(), Ok(expected));
            assert!(!policy.lock().unwrap().in_flight);
            let events = group_events.lock().unwrap();
            let Some(executor::GroupEvent::Signal(pid)) = events.first() else {
                panic!("expected the owned group to be signalled");
            };
            // A stuck OS may exceed the cleanup budget. When a reap occurs it
            // must always be last, and cleanup must never signal a reused ID.
            let (signals, reaped) = match events.split_last() {
                Some((executor::GroupEvent::Reaped(reaped), signals)) => (signals, Some(*reaped)),
                _ => (&events[..], None),
            };
            assert!(reaped.is_none_or(|reaped| reaped == *pid));
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
        assert_eq!(assert_withheld(execution, State::Revoked), (Some(0), None));
        assert_eq!(request.state(), Ok(State::Completed));
    }

    #[test]
    fn completed_launch_expires_before_output_handoff() {
        let policy = policy();
        let request = approved(&policy, input("one"));
        let execution = policy.start(&request).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while request.state() != Ok(State::Completed) {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        set_time(&policy, 100);
        assert_eq!(
            assert_withheld(execution, State::ExpiredAfterLaunch),
            (Some(0), None)
        );
        assert_eq!(request.state(), Ok(State::ExpiredAfterLaunch));
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
