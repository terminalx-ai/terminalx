//! Independent chat views. Unlike Quick Chat, each New Window invocation
//! creates a window, and closing it destroys only that view.

use tauri::{AppHandle, Emitter, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn is_chat_window(label: &str) -> bool {
    label.starts_with("chat-")
}

fn new_label() -> String {
    format!("chat-{}", uuid::Uuid::new_v4())
}

// Window creation must run off the event loop to avoid a WebView2 deadlock.
#[tauri::command]
pub async fn new_chat_window(app: AppHandle) -> Result<(), String> {
    let builder = WebviewWindowBuilder::new(&app, new_label(), WebviewUrl::App("index.html".into()))
        .title("TerminalX Chat")
        .inner_size(600.0, 760.0)
        .min_inner_size(420.0, 400.0)
        .resizable(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .transparent(true)
        .effects(tauri::window::EffectsBuilder::new().effect(tauri::window::Effect::Sidebar).state(tauri::window::EffectState::Active).build());
    let window = builder.build().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn chat_window_open_in_main(app: AppHandle, window: WebviewWindow, session_id: String, tab_id: Option<String>) -> Result<(), String> {
    if !is_chat_window(window.label()) {
        return Err("Only an independent chat window can move its view to the main window".into());
    }
    app.emit_to("main", "open_session", crate::floating::OpenTarget { session_id, tab_id }).map_err(|error| error.to_string())?;
    crate::account::focus_main_window(&app);
    window.close().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_windows_have_distinct_identities_and_never_reuse_quick_chat() {
        let first = new_label();
        let second = new_label();
        assert_ne!(first, second);
        assert!(is_chat_window(&first));
        assert!(is_chat_window(&second));
        assert!(!is_chat_window(crate::floating::LABEL));
        assert!(!is_chat_window("main"));
    }
}
