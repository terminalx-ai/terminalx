// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    attach_cli_console();
    // `raccoon hook <Event>` is how the agent CLIs' hooks reach a running app.
    // It has to be answered before Tauri starts: the hook process is short
    // lived and must never open a window.
    if raccoon_lib::hooks::run_statusline_cli() || raccoon_lib::hooks::run_hook_cli() {
        return;
    }
    if let Some(code) = raccoon_lib::cli::run_cli() {
        std::process::exit(code);
    }
    raccoon_lib::run()
}

// A release GUI binary has no console unless the CLI invocation attaches to
// its parent. Keep redirected handles intact for agents reading JSON pipes.
#[cfg(windows)]
fn attach_cli_console() {
    let args: Vec<_> = std::env::args().collect();
    let executable = args.first().and_then(|arg| std::path::Path::new(arg).file_stem()).and_then(|s| s.to_str());
    let cli = matches!(executable, Some("terminalx" | "tnx"))
        || args.get(1).is_some_and(|arg| matches!(arg.as_str(), "terminalx" | "tnx" | "hook" | "statusline"));
    if !cli { return; }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(kind: u32) -> *mut std::ffi::c_void;
        fn AttachConsole(process_id: u32) -> i32;
    }
    unsafe {
        let stdout = GetStdHandle(-11_i32 as u32);
        if stdout.is_null() || stdout as isize == -1 { AttachConsole(u32::MAX); }
    }
}
