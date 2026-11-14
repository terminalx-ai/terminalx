//! The headless TerminalX runtime. Everything lives in `raccoon_lib::serve`,
//! which the desktop build also compiles, so the two cannot drift apart.

/// A terminal's supervisor runs before anything else in this process (#467).
#[cfg(target_os = "linux")]
#[used]
#[link_section = ".preinit_array"]
static PTY_SUPERVISOR: extern "C" fn(i32, *const *const u8, *const *const u8) = {
    extern "C" fn preinit(argc: i32, argv: *const *const u8, envp: *const *const u8) {
        raccoon_lib::pty_supervisor_preinit(argc, argv.cast(), envp.cast())
    }
    preinit
};

fn main() {
    if let Some(code) = raccoon_lib::run_git_transport_cli() { std::process::exit(code); }
    std::process::exit(raccoon_lib::serve::main());
}
