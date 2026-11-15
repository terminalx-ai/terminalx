//! `terminalx-serve login` and `logout`: built by the PRO-353 orchestration
//! run's piece that owns this file. See `super` for the shared layout.

/// Run `terminalx-serve login` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    let _ = args;
    eprintln!("terminalx-serve login: not available in this build yet");
    2
}

/// Run `terminalx-serve logout` with the arguments after its name.
pub fn run_logout(args: &[String]) -> i32 {
    let _ = args;
    eprintln!("terminalx-serve logout: not available in this build yet");
    2
}
