//! Helpers shared by the serve integration tests.
#![allow(dead_code)]

pub mod agent;
#[cfg(unix)]
pub mod machine;
pub mod mailbox;
/// A relay for the machine routes that runs inside the test (PRO-358).
#[cfg(unix)]
pub mod relay;
/// Several machines on one host for the two-machine end-to-end tests (PRO-358).
#[cfg(unix)]
pub mod world;
