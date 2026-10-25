//! Selected-task execution in a local guest. These identities never denote a
//! host checkout or a cloud organization. The supervisor, rather than a view,
//! owns this journal; deleting a VM must not delete it.

pub mod desktop;
pub mod guest;
pub mod host;
pub mod journal;
mod process;
pub mod provisioning;
pub mod supervisor;
