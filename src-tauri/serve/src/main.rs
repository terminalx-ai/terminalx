//! The headless TerminalX runtime. Everything lives in `raccoon_lib::serve`,
//! which the desktop build also compiles, so the two cannot drift apart.

fn main() {
    if let Some(code) = raccoon_lib::run_git_transport_cli() { std::process::exit(code); }
    std::process::exit(raccoon_lib::serve::main());
}
