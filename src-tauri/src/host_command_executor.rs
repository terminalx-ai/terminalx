//! Private executor for the policy. macOS process groups cover descendants that remain in
//! the group. An explicitly approved program runs as the desktop user and can leave the group
//! or access files available to that user.

#[cfg(target_os = "macos")]
#[path = "host_command_executor_macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
pub(super) use macos::{run, ApprovedPaths};

#[cfg(all(test, target_os = "macos"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GroupEvent {
    Signal(i32),
    Reaped(i32),
}

#[cfg(not(target_os = "macos"))]
mod unsupported {
    use super::super::{ExecutionOutcome, ExecutionSlot, Rejection, Request, RequestInput, State};
    use std::sync::mpsc::SyncSender;

    pub(in super::super) struct ApprovedPaths;

    impl ApprovedPaths {
        pub(in super::super) fn open(_: &RequestInput) -> Result<Self, Rejection> {
            Err(Rejection::UnsupportedPlatform)
        }
    }

    pub(in super::super) fn run(
        request: &Request,
        _: ApprovedPaths,
        sender: SyncSender<ExecutionOutcome>,
        slot: ExecutionSlot<'_>,
    ) {
        let state = request.finish(State::SpawnFailed);
        drop(slot);
        let _ = sender.send(ExecutionOutcome::Stopped(state));
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) use unsupported::{run, ApprovedPaths};
