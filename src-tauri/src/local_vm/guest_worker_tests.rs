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
