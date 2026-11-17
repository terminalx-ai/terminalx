use super::*;
use anyhow::bail;
use std::io::Cursor;
use std::os::unix::net::UnixStream;

fn binding() -> Binding {
    Binding {
        environment: super::super::journal::new_id(),
        generation: super::super::journal::new_id(),
        epoch: super::super::journal::new_id(),
    }
}
fn request(binding: &Binding) -> Request {
    Request {
        version: VERSION,
        binding: binding.clone(),
        sequence: 1,
        target: None,
        command: Operation::Shutdown,
    }
}
fn frame(value: &impl Serialize) -> Vec<u8> {
    let bytes = serde_json::to_vec(value).unwrap();
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend(bytes);
    frame
}
fn pair() -> (UnixStream, UnixStream) {
    let (a, b) = UnixStream::pair().unwrap();
    for stream in [&a, &b] {
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
    }
    (a, b)
}
#[test]
fn malformed_oversized_truncated_and_aggregate_frames_fence_channel() {
    let hello = Hello {
        version: VERSION,
        binding: binding(),
    };
    let bytes = frame(&hello);
    // Every header/body EOF position, including no bytes delivered.
    for length in 0..bytes.len() {
        let mut wire = Wire::new(Cursor::new(bytes[..length].to_vec()));
        assert!(wire.receive::<Hello>().is_err());
        assert!(wire.poisoned);
        assert!(wire.receive::<Hello>().is_err());
    }
    for bytes in [
        vec![0, 0, 0, 0],
        ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec(),
        vec![0, 0, 0, 1, b'{'],
    ] {
        let mut wire = Wire::new(Cursor::new(bytes));
        assert!(wire.receive::<Hello>().is_err());
        assert!(wire.poisoned);
    }
    let mut wire = Wire::new(Cursor::new(frame(&hello)));
    wire.remaining = 4;
    assert!(wire.receive::<Hello>().is_err());
    assert!(wire.poisoned);
    let mut wire = Wire::new(Cursor::new(Vec::new()));
    assert!(wire.send(&"x".repeat(MAX_FRAME)).is_err());
    assert!(wire.io.into_inner().is_empty()); // no partial oversized frame
}
#[test]
fn binding_scope_duplicates_reordering_and_restart_are_rejected() {
    let b = binding();
    let mut req = request(&b);
    assert!(req.validate(&b, 1).is_ok());
    assert!(req.validate(&b, 2).is_err());
    req.sequence = 2;
    assert!(req.validate(&b, 1).is_err());
    req.sequence = 1;
    let mut restarted = b.clone();
    restarted.epoch = super::super::journal::new_id();
    assert!(req.validate(&restarted, 1).is_err());
    req.command = Operation::WorkspaceSnapshot { after: None };
    assert!(req.validate(&b, 1).is_err());
    req.target = Some(TaskTarget {
        environment_id: b.environment.clone(),
        generation: b.generation.clone(),
        task_id: super::super::journal::new_id(),
        workspace_id: super::super::journal::new_id(),
    });
    assert!(req.validate(&b, 1).is_ok());
    req.target.as_mut().unwrap().generation = super::super::journal::new_id();
    assert!(req.validate(&b, 1).is_err());
    let invalid = serde_json::json!({"operation":"execute", "command":"sh"});
    assert!(serde_json::from_value::<Operation>(invalid).is_err());
}
#[test]
fn relative_file_names_cannot_address_owner_state() {
    for name in [
        "/var/lib/terminalx-owner/.terminalx-local/identity.json",
        "../owner",
        "a/../../owner",
        "a\\b",
        "a//b",
        "a/./b",
    ] {
        assert!(FileBytes {
            name: name.into(),
            content_base64: "YQ==".into()
        }
        .validate()
        .is_err());
    }
    assert!(FileBytes {
        name: "src/main.rs".into(),
        content_base64: "YQ==".into()
    }
    .validate()
    .is_ok());
}
#[test]
fn checkpoint_precedes_dispatch_and_receipt_loss_never_replays() {
    let (a, b) = pair();
    let binding = binding();
    let checkpointed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = checkpointed.clone();
    let child = std::thread::spawn(move || {
        let mut worker = Worker::accept(b).unwrap();
        // Dispatch executes once, but the handler loses its outcome.
        assert!(worker
            .dispatch(|_| {
                assert!(observed.load(std::sync::atomic::Ordering::SeqCst));
                bail!("injected loss after effect")
            })
            .is_err());
        assert!(worker.dispatch(|_| panic!("replayed effect")).is_err());
    });
    let mut owner = Owner::connect(a, binding).unwrap();
    assert!(owner
        .request(None, Operation::Shutdown, |_| {
            checkpointed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .is_err());
    assert!(owner
        .request(None, Operation::Shutdown, |_| panic!(
            "fenced request checkpointed again"
        ))
        .is_err());
    child.join().unwrap();
}
#[test]
fn failed_checkpoint_does_not_dispatch_and_next_request_can_succeed() {
    let (a, b) = pair();
    let child = std::thread::spawn(move || {
        let mut worker = Worker::accept(b).unwrap();
        worker
            .dispatch(|req| {
                assert_eq!(req.sequence, 1);
                Ok(Observation::Stopped {
                    extinction_confirmed: false,
                })
            })
            .unwrap();
    });
    let mut owner = Owner::connect(a, binding()).unwrap();
    assert!(owner
        .request(None, Operation::Shutdown, |_| bail!("disk full"))
        .is_err());
    assert!(matches!(
        owner
            .request(None, Operation::Shutdown, |_| Ok(()))
            .unwrap(),
        Observation::Stopped {
            extinction_confirmed: false
        }
    ));
    child.join().unwrap();
}
#[test]
fn eof_at_every_receipt_boundary_fences_owner() {
    let b = binding();
    let response = Reply {
        version: VERSION,
        binding: b.clone(),
        sequence: 1,
        target: None,
        result: Observation::Stopped {
            extinction_confirmed: false,
        },
    };
    let bytes = frame(&response);
    // A scripted duplex avoids hundreds of threads while exercising Owner's
    // exact send/read/fence path at every partial-receipt byte boundary.
    struct Duplex(Cursor<Vec<u8>>);
    impl DeadlineIo for Duplex {
        fn set_deadline(&mut self, deadline: std::time::Instant) -> std::io::Result<()> {
            time_left(deadline).map(|_| ())
        }
    }
    impl Read for Duplex {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(out)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    for end in 0..bytes.len() {
        let mut input = frame(&Hello {
            version: VERSION,
            binding: b.clone(),
        });
        input.extend_from_slice(&bytes[..end]);
        let mut owner = Owner::connect(Duplex(Cursor::new(input)), b.clone()).unwrap();
        assert!(owner
            .request(None, Operation::Shutdown, |_| Ok(()))
            .is_err());
        assert!(owner.wire.poisoned);
    }
}
#[test]
fn cross_task_reply_is_fenced_without_accepting_observation() {
    let (a, b) = pair();
    let binding = binding();
    let child = std::thread::spawn(move || {
        let mut worker = Worker::accept(b).unwrap();
        let req: Request = worker.wire.receive().unwrap();
        let mut wrong = req.target.unwrap();
        wrong.task_id = super::super::journal::new_id();
        worker
            .wire
            .send(&Reply {
                version: VERSION,
                binding: req.binding,
                sequence: req.sequence,
                target: Some(wrong),
                result: Observation::Stopped {
                    extinction_confirmed: true,
                },
            })
            .unwrap();
    });
    let target = TaskTarget {
        environment_id: binding.environment.clone(),
        generation: binding.generation.clone(),
        task_id: super::super::journal::new_id(),
        workspace_id: super::super::journal::new_id(),
    };
    let mut owner = Owner::connect(a, binding).unwrap();
    assert!(owner
        .request(
            Some(target),
            Operation::WorkspaceSnapshot { after: None },
            |_| Ok(())
        )
        .is_err());
    assert!(owner.wire.poisoned);
    child.join().unwrap();
}

#[test]
fn wrong_reply_kind_and_worker_paths_are_not_accepted_as_receipts() {
    assert!(Observation::Stopped {
        extinction_confirmed: true
    }
    .validate(&Operation::AccountVerify)
    .is_err());
    assert!(Observation::Files {
        files: vec![FileBytes {
            name: "/var/lib/terminalx-owner/.terminalx-local/runtime/control.token".into(),
            content_base64: "YQ==".into(),
        }],
        next: None
    }
    .validate(&Operation::WorkspaceSnapshot { after: None })
    .is_err());
}

#[test]
fn duplicate_dispatch_and_handler_failure_cannot_reenter_effect() {
    let b = binding();
    let req = request(&b);
    struct Duplex(Cursor<Vec<u8>>);
    impl DeadlineIo for Duplex {
        fn set_deadline(&mut self, deadline: std::time::Instant) -> std::io::Result<()> {
            time_left(deadline).map(|_| ())
        }
    }
    impl Read for Duplex {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(out)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut input = frame(&Hello {
        version: VERSION,
        binding: b,
    });
    input.extend(frame(&req));
    input.extend(frame(&req));
    let mut worker = Worker::accept(Duplex(Cursor::new(input))).unwrap();
    worker
        .dispatch(|_| {
            Ok(Observation::Stopped {
                extinction_confirmed: false,
            })
        })
        .unwrap();
    assert!(worker
        .dispatch(|_| panic!("duplicate request executed"))
        .is_err());
    assert!(worker.wire.poisoned);
}

fn lifetime_pipe() -> (std::os::fd::OwnedFd, std::os::fd::OwnedFd) {
    use std::os::fd::FromRawFd;
    let mut fds = [-1; 2];
    // SAFETY: pipe initializes two fresh descriptors, each adopted once below.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    for fd in fds {
        // Match the launcher's pipe2(O_CLOEXEC): a provider must not inherit
        // the owner's write end and keep its own lifetime alive.
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
    }
    unsafe {
        (
            std::os::fd::OwnedFd::from_raw_fd(fds[0]),
            std::os::fd::OwnedFd::from_raw_fd(fds[1]),
        )
    }
}

#[test]
fn lifetime_watcher_stops_retained_child_during_blocked_effect_without_a_receipt() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    };
    use std::time::Duration;
    let (mut owner, stream) = pair();
    let (read, write) = lifetime_pipe();
    let channel = channel::Channel::new(stream.into(), read).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (stopped_tx, stopped_rx) = mpsc::channel();
    let stops = Arc::new(AtomicUsize::new(0));
    let counted = stops.clone();
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let worker = std::thread::spawn(move || {
        serve_channel(
            channel,
            |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5))?;
                Ok(Observation::Stopped {
                    extinction_confirmed: true,
                })
            },
            move || {
                counted.fetch_add(1, Ordering::SeqCst);
                child.kill().unwrap();
                let status = child.wait().unwrap(); // Original retained child, not a PID lookup.
                stopped_tx.send(status).unwrap();
            },
        )
    });
    let b = binding();
    let mut wire = Wire::new(&mut owner);
    wire.send(&Hello {
        version: VERSION,
        binding: b.clone(),
    })
    .unwrap();
    let _: Hello = wire.receive().unwrap();
    wire.send(&request(&b)).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    drop(write);
    // No release of the blocked dispatcher is needed to initiate child shutdown.
    assert!(!stopped_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .success());
    release_tx.send(()).unwrap();
    assert!(worker.join().unwrap().is_err());
    assert!(wire.receive::<Reply>().is_err());
    assert_eq!(stops.load(Ordering::SeqCst), 1);
}

#[test]
fn malformed_handshake_initiates_shutdown_without_lifetime_eof() {
    use std::sync::mpsc;
    use std::time::Duration;
    let (mut owner, stream) = pair();
    let (read, _write) = lifetime_pipe();
    let channel = channel::Channel::new(stream.into(), read).unwrap();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        serve_channel(
            channel,
            |_| panic!("malformed handshake dispatched"),
            move || {
                tx.send(()).unwrap();
            },
        )
    });
    owner.write_all(&0u32.to_be_bytes()).unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(worker.join().unwrap().is_err());
}

#[test]
fn dispatcher_failure_initiates_shutdown_even_while_owner_descriptors_stay_open() {
    use std::sync::mpsc;
    use std::time::Duration;
    let (owner, stream) = pair();
    let (read, _write) = lifetime_pipe();
    let channel = channel::Channel::new(stream.into(), read).unwrap();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        serve_channel(
            channel,
            |_| bail!("effect could have started"),
            move || {
                tx.send(()).unwrap();
            },
        )
    });
    let mut owner = Owner::connect(owner, binding()).unwrap();
    assert!(owner
        .request(None, Operation::Shutdown, |_| Ok(()))
        .is_err());
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(worker.join().unwrap().is_err());
}

#[test]
fn trickled_frame_has_one_deadline_and_fences_late_reply() {
    let (reader, writer) = pair();
    assert_trickle_deadline(reader, writer);
    let (reader, writer) = pair();
    let (lifetime, _keep_alive) = lifetime_pipe();
    assert_trickle_deadline(
        channel::Channel::new(reader.into(), lifetime).unwrap(),
        writer,
    );
}

fn assert_trickle_deadline(reader: impl DeadlineIo, mut writer: UnixStream) {
    use std::time::{Duration, Instant};
    let hello = Hello {
        version: VERSION,
        binding: binding(),
    };
    let bytes = frame(&hello);
    let sender = std::thread::spawn(move || {
        for byte in bytes {
            if writer.write_all(&[byte]).is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    let mut wire = Wire::new(reader);
    wire.frame_timeout = Duration::from_millis(100);
    let start = Instant::now();
    assert!(wire.receive::<Hello>().is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(wire.poisoned);
    assert!(wire.receive::<Hello>().is_err());
    drop(wire);
    sender.join().unwrap();
}

#[test]
fn blocked_frame_write_is_bounded_and_fenced() {
    use std::time::{Duration, Instant};
    let (writer, _unread_peer) = pair();
    let mut wire = Wire::new(writer);
    wire.frame_timeout = Duration::from_millis(100);
    let start = Instant::now();
    assert!(wire.send(&"x".repeat(MAX_FRAME / 2)).is_err());
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(wire.poisoned);
    assert!(wire.send(&true).is_err());
}
