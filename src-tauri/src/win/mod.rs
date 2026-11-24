//! The Windows platform layer: owner-only access, process identity and
//! lifetime, and per-user secret sealing, which the rest of the crate uses
//! where Unix code uses file modes, uids, signals and the Keychain.
pub(crate) mod dpapi;
pub(crate) mod fs;
pub(crate) mod net;
pub(crate) mod pipe;
pub(crate) mod process;
pub(crate) mod security;
