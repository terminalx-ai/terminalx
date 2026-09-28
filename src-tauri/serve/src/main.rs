//! The headless TerminalX runtime. Everything lives in `raccoon_lib::serve`,
//! which the desktop build also compiles, so the two cannot drift apart.

fn main() {
    std::process::exit(raccoon_lib::serve::main());
}
