//! Validation probe entry point. Takes no arguments or environment: the root,
//! port, schedule and log location are fixed. Always exits 0 (see probe.rs).
#[cfg(target_os = "macos")]
fn main() {
    use terminalx_vm_bootstrap::{probe, wire};
    let outcome = std::panic::catch_unwind(|| {
        probe::run(
            &probe::Layout::system(),
            &probe::Schedule::VALIDATION,
            wire::connect_host,
            std::thread::sleep,
        )
    });
    match outcome {
        Ok(probe::Outcome::Recorded { .. }) => {}
        Ok(other) => eprintln!("{}: {other:?}", probe::LABEL),
        Err(_) => eprintln!("{}: stopped after an internal error", probe::LABEL),
    }
    std::process::exit(0);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("terminalx-vm-validation-probe runs only inside a macOS guest");
    std::process::exit(0);
}
