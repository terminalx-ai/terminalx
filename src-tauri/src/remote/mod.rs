//! Cloud workspaces reach their runtime over the relay's end-to-end
//! encrypted channel and `terminalx-workspace-rpc/1` (PRO-13):
//! - [`protocol`]: the methods, authority, idempotency and close codes both
//!   ends share.
//! - [`server`]: what `terminalx-serve` answers (terminals, files, Git, agent
//!   sessions).
//! - [`host`]: the runtime's outbound relay registration.
//! - [`client`]: the desktop's attach, E2EE and supervision.

pub mod bootstrap_link;
pub mod client;
pub mod host;
pub mod protocol;
pub mod server;
