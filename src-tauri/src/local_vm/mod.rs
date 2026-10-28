//! Selected-task execution in a local guest. These identities never denote a
//! host checkout or a cloud organization. The supervisor, rather than a view,
//! owns this journal; deleting a VM must not delete it.

pub mod desktop;
pub mod bootstrap;
mod creation;
pub mod guest;
pub mod host;
pub mod journal;
mod owner_shutdown;
mod process;
pub mod provisioning;
pub mod supervisor;
pub mod setup;
mod linux_setup;
pub mod transport;
pub(crate) mod admission;
pub(crate) mod attachment;
pub mod linux_profile;
pub(crate) mod linux_install;
pub mod macos_personalization;
pub mod macos_account;
pub mod macos_transport;
mod macos_keys;

pub(crate) mod linux_activation;
mod macos_endpoint;
pub(crate) mod macos_delivery;
pub(crate) mod macos_provision;
mod macos_tools;
#[allow(dead_code)] // No broker/CLI route until authenticated owner/share acquisition exists.
mod macos_bootstrap_helper;
