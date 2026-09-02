// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `raccoon hook <Event>` is how the agent CLIs' hooks reach a running app.
    // It has to be answered before Tauri starts: the hook process is short
    // lived and must never open a window.
    if raccoon_lib::hooks::run_statusline_cli() || raccoon_lib::hooks::run_hook_cli() {
        return;
    }
    raccoon_lib::run()
}
