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
#[allow(dead_code)] // For the privileged seeder (slice 5) and the version-3 launch; neither is routed yet.
mod macos_seed;
#[cfg(feature = "vm-validation")]
mod macos_validation;
mod macos_tools;
#[allow(dead_code)] // Shared storage for the gated helper and candidate owner channel.
mod macos_helper_fs;
#[allow(dead_code)] // No broker/CLI route until authenticated owner/share acquisition exists.
mod macos_bootstrap_helper;
#[allow(dead_code)] // Shared with the guest account child; used through the gated helper engine.
mod authorized_keys_text;
#[allow(dead_code)] // Candidate only; no approved profile or production launch route.
mod macos_owner_channel;
#[allow(dead_code)] // Person-only actions; this build has no approver, so they fail closed.
mod person_approval;
