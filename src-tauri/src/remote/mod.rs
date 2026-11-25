//! Cloud workspaces reach their runtime over the relay's end-to-end
//! encrypted channel and `terminalx-workspace-rpc/1` (PRO-13):
//! - [`protocol`]: the methods, authority, idempotency and close codes both
//!   ends share.
//! - [`server`]: what `terminalx-serve` answers (terminals, files, Git, agent
//!   sessions).
//! - [`files`]: `fs/1`, the workspace's files as the runtime serves them.
//! - [`git`]: `git/1` and the repository facts of `lifecycle/1`.
//! - [`host`]: the runtime's outbound relay registration.
//! - [`account_link`]: a signed-in machine's relay session (PRO-368).
//! - [`client`]: the desktop's attach, E2EE and supervision.
//! - [`collab`]: who may do what in a shared workspace (`collab/1`, PRO-30).
//! - [`machine`]: `machine/1`, one runtime serving every project of its
//!   machine (PRO-340).
//! - [`machine_client`]: the operating computer's one connection per paired
//!   machine, over its direct routes and the relay (PRO-345).
//! - [`ports`] and [`port_listeners`]: `ports/1`, a workspace port carried
//!   over the connection, and what listens on which port (PRO-28, PRO-355).
//! - [`machine_projects`]: `machine/6`, a machine's projects from another
//!   computer: browse its folders, add, remove and clone (PRO-351).
//! - [`machine_session`]: `machine/8`, a machine session's cost, account
//!   labels, Continue in a new tab and Fix check errors (PRO-408).
//! - [`agent_commands`]: receipts of live agent commands on a runtime with
//!   no cloud mailbox (`agent-commands/1`, PRO-343).

pub mod account_link;
pub mod agent_commands;
pub mod bootstrap_link;
pub mod bots;
pub mod client;
#[cfg(all(test, unix))]
mod cloud_desktop;
pub mod collab;
pub mod environment;
pub mod files;
pub mod git;
pub mod host;
pub mod machine;
pub(crate) mod machine_agents;
pub mod machine_projects;
pub(crate) mod machine_session;
pub mod machine_client;
pub mod machine_update;
pub mod mirror;
pub mod port_listeners;
pub mod ports;
pub mod protocol;
pub mod server;
pub(crate) mod session_target;
