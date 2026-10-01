//! Cloud workspaces reach their runtime over the relay's end-to-end
//! encrypted channel and `terminalx-workspace-rpc/1` (PRO-13):
//! - [`protocol`]: the methods, authority, idempotency and close codes both
//!   ends share.
//! - [`server`]: what `terminalx-serve` answers (terminals, files, Git, agent
//!   sessions).
//! - [`files`]: `fs/1`, the workspace's files as the runtime serves them.
//! - [`git`]: `git/1` and the repository facts of `lifecycle/1`.
//! - [`host`]: the runtime's outbound relay registration.
//! - [`client`]: the desktop's attach, E2EE and supervision.
//! - [`collab`]: who may do what in a shared workspace (`collab/1`, PRO-30).

pub mod bootstrap_link;
pub mod client;
pub mod collab;
pub mod files;
pub mod git;
pub mod host;
pub mod protocol;
pub mod server;
