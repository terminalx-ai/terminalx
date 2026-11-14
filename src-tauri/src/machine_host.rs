//! The runtime accepts operating computers itself (PRO-341, docs/MACHINES.md
//! decision 4): over the direct listener and through the relay, with the
//! machine's one host key and a registry of paired computers kept apart
//! from the phones' `devices.json`. What it says to the window is in
//! `crate::machine_wire`.
