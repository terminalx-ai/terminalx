//! Production guest helper entry point, started by launchd as root from the
//! seeded plist. Takes no arguments or environment: the layout, port and
//! schedule are fixed. Always exits 0 (see helper.rs).
#[cfg(target_os = "macos")]
fn main() {
    use terminalx_vm_bootstrap::{child, helper};
    let outcome = std::panic::catch_unwind(|| {
        let layout = helper::Layout::system();
        let mut installer = child::Forking {
            state: layout.state(),
        };
        helper::run(
            &layout,
            0,
            &helper::Schedule::PRODUCTION,
            &mut helper::System,
            &mut installer,
        )
    });
    match outcome {
        Ok(outcome) => eprintln!("{}: {outcome:?}", helper::LABEL),
        Err(_) => eprintln!("{}: stopped after an internal error", helper::LABEL),
    }
    std::process::exit(0);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("terminalx-vm-bootstrap runs only inside a macOS guest");
    std::process::exit(0);
}
