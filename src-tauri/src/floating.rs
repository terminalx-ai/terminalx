//! The floating chat window: a second, compact window for talking to an agent
//! without choosing a project first.
//!
//! It is made the first time it is asked for and kept from then on: closing
//! it hides it, so what it shows (and the agents behind it, which are the
//! backend's, not the window's) carries on. It is a view of the same app
//! state as the main window and owns nothing of its own.
//!
//! How it is reached:
//! - a system-wide shortcut (Settings → Shortcuts), which can be changed or
//!   turned off, and whose registration can fail when another app holds it;
//! - the tray icon;
//! - the main window (a toolbar button and the command palette);
//! - `terminalx floating show|hide|toggle`.
//!
//! What differs by platform:
//! - **macOS**: stays on top when pinned, joins every Space, and is shown over
//!   another app's full-screen Space (`FullScreenAuxiliary`).
//! - **Windows**: stays on top when pinned. Virtual desktops have no public
//!   "on every desktop" switch, so it stays on the desktop it was shown on.
//! - **Linux**: always-on-top and all-workspaces are requests the window
//!   manager may ignore, and mostly does under Wayland. System-wide shortcuts
//!   are X11 only: under Wayland registration fails, Settings says so, and
//!   the tray, the main window and the command line still open the window
//!   (bind `terminalx floating toggle` in the compositor's own shortcuts).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::store::settings::{self, FloatingSettings};

pub const LABEL: &str = "floating";
/// Settings or the shortcut's registration changed: `FloatingStatus`.
pub const STATUS_EVENT: &str = "floating_status";
/// The floating window is asked to show a session: an [`OpenTarget`].
pub const OPEN_EVENT: &str = "floating_open";
/// The main window is asked to show a session: an [`OpenTarget`].
pub const OPEN_IN_MAIN_EVENT: &str = "open_session";
/// The floating window was shown (`true`) or hidden (`false`). A hidden
/// window's page is still running, so it is told rather than left to guess:
/// what it shows while hidden has not been seen by anyone.
pub const VISIBLE_EVENT: &str = "floating_visible";

/// A session to show, and the tab of it when one is meant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenTarget {
    pub session_id: String,
    #[serde(default)]
    pub tab_id: Option<String>,
}

const DEFAULT_SIZE: (f64, f64) = (460.0, 640.0);
const MIN_SIZE: (f64, f64) = (360.0, 420.0);

/// What the window's state is beyond its settings.
#[derive(Default)]
pub struct Floating {
    /// The shortcut the system has registered for us, if any.
    registered: Mutex<Option<Shortcut>>,
    /// Why the configured shortcut is not registered; `None` when it is, or
    /// when it is turned off.
    shortcut_error: Mutex<Option<String>>,
    /// A session to show, asked for before the window's page had loaded.
    pending: Mutex<Option<OpenTarget>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingStatus {
    #[serde(flatten)]
    pub settings: FloatingSettings,
    /// The shortcut is set but could not be registered, and why.
    pub shortcut_error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingPatch {
    /// A binding in the app's own form (`alt+shift+space`); blank turns the shortcut off.
    #[serde(default)]
    pub shortcut: Option<String>,
    #[serde(default)]
    pub always_on_top: Option<bool>,
    #[serde(default)]
    pub retention_days: Option<u32>,
}

/// A binding as the app writes it (`mod+shift+space`, see `src/lib/shortcuts.ts`)
/// as the accelerator the system registers.
///
/// A system-wide shortcut takes the keys from every other app, so it needs a
/// modifier that is not Shift alone: a bare key or Shift+key would swallow
/// ordinary typing everywhere.
pub fn accelerator(binding: &str) -> Result<String, String> {
    let binding = binding.trim().to_lowercase();
    // "mod++" binds the plus key: the last part is the key, whatever it is.
    let (modifiers, key) = match binding.strip_suffix("++") {
        Some(modifiers) => (modifiers.to_string(), "+".to_string()),
        None => match binding.rsplit_once('+') {
            Some((modifiers, key)) => (modifiers.to_string(), key.to_string()),
            None => (String::new(), binding.clone()),
        },
    };
    let mut parts = Vec::new();
    let mut commanding = false;
    for modifier in modifiers.split('+').filter(|part| !part.is_empty()) {
        let (name, commands) = match modifier {
            "mod" => ("CommandOrControl", true),
            "ctrl" | "control" => ("Control", true),
            "meta" | "cmd" | "command" | "super" => ("Super", true),
            "alt" | "option" => ("Alt", true),
            "shift" => ("Shift", false),
            other => return Err(format!("\"{other}\" is not a modifier key.")),
        };
        commanding |= commands;
        if !parts.contains(&name) {
            parts.push(name);
        }
    }
    if !commanding {
        return Err("A system-wide shortcut needs Command, Control or Option: without one it would take the key from every other app.".into());
    }
    let named = match key.as_str() {
        "" => return Err("The shortcut has no key.".into()),
        "space" => "Space".to_string(),
        "enter" | "return" => "Enter".to_string(),
        "tab" => "Tab".to_string(),
        "escape" | "esc" => "Escape".to_string(),
        "backspace" => "Backspace".to_string(),
        "delete" => "Delete".to_string(),
        "up" => "ArrowUp".to_string(),
        "down" => "ArrowDown".to_string(),
        "left" => "ArrowLeft".to_string(),
        "right" => "ArrowRight".to_string(),
        "home" => "Home".to_string(),
        "end" => "End".to_string(),
        "pageup" => "PageUp".to_string(),
        "pagedown" => "PageDown".to_string(),
        "-" => "Minus".to_string(),
        "=" | "+" | "plus" => "Equal".to_string(),
        "[" => "BracketLeft".to_string(),
        "]" => "BracketRight".to_string(),
        "\\" => "Backslash".to_string(),
        ";" => "Semicolon".to_string(),
        "'" => "Quote".to_string(),
        "," => "Comma".to_string(),
        "." => "Period".to_string(),
        "/" => "Slash".to_string(),
        "`" => "Backquote".to_string(),
        key if key.len() == 1 && key.chars().all(|c| c.is_ascii_alphabetic()) => format!("Key{}", key.to_uppercase()),
        key if key.len() == 1 && key.chars().all(|c| c.is_ascii_digit()) => format!("Digit{key}"),
        key if key.len() >= 2 && key.starts_with('f') && key[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) => key.to_uppercase(),
        other => return Err(format!("\"{other}\" cannot be used in a system-wide shortcut.")),
    };
    parts.push(&named);
    Ok(parts.join("+"))
}

fn shortcut_of(binding: &str) -> Result<Shortcut, String> {
    accelerator(binding)?.parse::<Shortcut>().map_err(|error| format!("The system does not accept this shortcut: {error}"))
}

/// Why a registration failed, in words for Settings.
fn registration_error(binding: &str, error: impl std::fmt::Display) -> String {
    let detail = error.to_string();
    if cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return format!("System-wide shortcuts are not available under Wayland ({detail}). Bind `terminalx floating toggle` in your desktop's own keyboard settings instead.");
    }
    format!("{binding} could not be registered; another app may already use it ({detail}). Choose different keys, or turn the shortcut off.")
}

pub fn status(app: &AppHandle) -> FloatingStatus {
    FloatingStatus { settings: settings::load().floating, shortcut_error: app.state::<Floating>().shortcut_error.lock().unwrap().clone() }
}

fn announce(app: &AppHandle) -> FloatingStatus {
    let status = status(app);
    let _ = app.emit(STATUS_EVENT, &status);
    status
}

/// Make the system's registration match the setting: drop the shortcut held
/// now, then register the configured one. A failure is kept for Settings to
/// show, and never stops the app.
pub fn register_shortcut(app: &AppHandle) {
    let state = app.state::<Floating>();
    let wanted = settings::load().floating.shortcut.filter(|binding| !binding.trim().is_empty());
    let mut registered = state.registered.lock().unwrap();
    if let Some(old) = registered.take() {
        let _ = app.global_shortcut().unregister(old);
    }
    let error = match wanted {
        None => None,
        Some(binding) => match shortcut_of(&binding) {
            Err(problem) => Some(problem),
            Ok(shortcut) => match app.global_shortcut().register(shortcut) {
                Ok(()) => {
                    *registered = Some(shortcut);
                    None
                }
                Err(error) => Some(registration_error(&binding, error)),
            },
        },
    };
    if let Some(error) = &error {
        log::warn!("floating window shortcut: {error}");
    }
    *state.shortcut_error.lock().unwrap() = error;
}

/// Whether a pressed shortcut is the one that toggles the window.
pub fn is_toggle_shortcut(app: &AppHandle, shortcut: &Shortcut) -> bool {
    app.state::<Floating>().registered.lock().unwrap().as_ref() == Some(shortcut)
}

pub fn update(app: &AppHandle, patch: FloatingPatch) -> Result<FloatingStatus, String> {
    let mut all = settings::load();
    let before = all.floating.clone();
    if let Some(shortcut) = patch.shortcut {
        let shortcut = shortcut.trim().to_lowercase();
        if shortcut.is_empty() {
            all.floating.shortcut = None;
        } else {
            // Refused before it is saved: a binding that cannot be a
            // system-wide shortcut would only fail again at every launch.
            shortcut_of(&shortcut)?;
            all.floating.shortcut = Some(shortcut);
        }
    }
    if let Some(always_on_top) = patch.always_on_top {
        all.floating.always_on_top = always_on_top;
    }
    if let Some(days) = patch.retention_days {
        all.floating.retention_days = days.min(settings::MAX_RETENTION_DAYS);
    }
    settings::save(&all).map_err(|error| format!("{error:#}"))?;
    if all.floating.shortcut != before.shortcut {
        register_shortcut(app);
    }
    if all.floating.always_on_top != before.always_on_top {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.set_always_on_top(all.floating.always_on_top);
        }
    }
    Ok(announce(app))
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let pinned = settings::load().floating.always_on_top;
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("TerminalX Quick Chat")
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .resizable(true)
        .always_on_top(pinned)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        // Shown once it exists and its saved place has been restored, not at
        // a default place first.
        .visible(false);
    // The same chrome as the main window: our own title bar strip over the
    // sidebar material.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .transparent(true)
        .effects(tauri::window::EffectsBuilder::new().effect(tauri::window::Effect::Sidebar).state(tauri::window::EffectState::Active).build());
    let window = builder.build()?;
    over_full_screen(&window);
    Ok(window)
}

/// macOS: let the window into every Space, including another app's
/// full-screen one. Tauri's all-workspaces switch covers ordinary Spaces only.
#[cfg(target_os = "macos")]
fn over_full_screen(window: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(pointer) = target.ns_window() else { return };
        if pointer.is_null() {
            return;
        }
        // SAFETY: Tauri hands out the live NSWindow of a window that exists,
        // and this runs on the main thread, where AppKit is used.
        let ns_window = unsafe { &*(pointer as *const NSWindow) };
        ns_window.setCollectionBehavior(ns_window.collectionBehavior() | NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary);
    });
}

#[cfg(not(target_os = "macos"))]
fn over_full_screen(_window: &WebviewWindow) {}

fn window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    match app.get_webview_window(LABEL) {
        Some(window) => Ok(window),
        None => build(app),
    }
}

/// Show the window and give it the keyboard. With `session`, it opens on that
/// session; otherwise on whatever it showed last.
pub fn show(app: &AppHandle, target: Option<OpenTarget>) -> tauri::Result<()> {
    if let Some(target) = target {
        // A page that is still loading reads this when it boots; one that is
        // up hears the event. Either way the request is not lost.
        *app.state::<Floating>().pending.lock().unwrap() = Some(target.clone());
        let _ = app.emit_to(LABEL, OPEN_EVENT, &target);
    }
    let window = window(app)?;
    let _ = window.unminimize();
    window.show()?;
    let _ = app.emit_to(LABEL, VISIBLE_EVENT, true);
    window.set_focus()
}

/// Hide the window. Nothing it shows is stopped: sessions and terminals are
/// the backend's.
pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
        let _ = app.emit_to(LABEL, VISIBLE_EVENT, false);
        remember_place(app);
    }
}

/// Whether the window is on screen. A page that has just loaded asks: the
/// event that said so may have gone out before it was listening.
pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some_and(|window| window.is_visible().unwrap_or(false))
}

/// Shown and focused: hide it. Hidden, or behind another app: bring it up.
pub fn toggle(app: &AppHandle) -> tauri::Result<()> {
    let up = app.get_webview_window(LABEL).is_some_and(|window| window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false));
    if up {
        hide(app);
        Ok(())
    } else {
        show(app, None)
    }
}

/// The session a just-loaded page should open on, once.
pub fn take_pending(app: &AppHandle) -> Option<OpenTarget> {
    app.state::<Floating>().pending.lock().unwrap().take()
}

/// Show `session` in the main window and put the floating one away.
pub fn open_in_main(app: &AppHandle, target: &OpenTarget) {
    let _ = app.emit_to("main", OPEN_IN_MAIN_EVENT, target);
    crate::account::focus_main_window(app);
    hide(app);
}

/// The window-state plugin saves when a window closes and when the app exits;
/// this window is only ever hidden, so its place is saved when it is.
fn remember_place(app: &AppHandle) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let _ = app.save_window_state(StateFlags::all());
}

/// The tray icon: the way to the floating window that needs no shortcut and
/// no main window.
fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    let quick = MenuItem::with_id(app, "tray-quick-chat", "Quick Chat", true, None::<&str>)?;
    let main = MenuItem::with_id(app, "tray-main-window", "Open TerminalX", true, None::<&str>)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit TerminalX"))?;
    let menu = Menu::with_items(app, &[&quick, &main, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("terminalx").tooltip("TerminalX").menu(&menu).show_menu_on_left_click(true).on_menu_event(|app, event| match event.id().as_ref() {
        "tray-quick-chat" => {
            if let Err(error) = show(app, None) {
                log::warn!("show the floating window: {error}");
            }
        }
        "tray-main-window" => crate::account::focus_main_window(app),
        _ => {}
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Wire the window's entry points once the app is up: the shortcut, the tray
/// and requests from the command line. None of them failing stops the app.
pub fn install(app: &AppHandle) {
    register_shortcut(app);
    if let Err(error) = install_tray(app) {
        log::warn!("tray icon: {error}");
    }
    let handle = app.clone();
    crate::sink::EventSink::listen(
        app,
        crate::session_ops::FLOATING_REQUEST_EVENT,
        Box::new(move |payload| {
            #[derive(Deserialize)]
            struct Request {
                action: String,
                #[serde(default)]
                session: Option<String>,
            }
            let Ok(request) = serde_json::from_str::<Request>(payload) else { return };
            let result = match request.action.as_str() {
                "show" => show(&handle, request.session.map(|session_id| OpenTarget { session_id, tab_id: None })),
                "hide" => {
                    hide(&handle);
                    Ok(())
                }
                _ => toggle(&handle),
            };
            if let Err(error) = result {
                log::warn!("floating window request: {error}");
            }
        }),
    );
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn floating_status(app: AppHandle) -> FloatingStatus {
    status(&app)
}

#[tauri::command]
pub fn set_floating_settings(app: AppHandle, patch: FloatingPatch) -> Result<FloatingStatus, String> {
    update(&app, patch)
}

#[tauri::command]
pub fn floating_show(app: AppHandle, session_id: Option<String>, tab_id: Option<String>) -> Result<(), String> {
    show(&app, session_id.map(|session_id| OpenTarget { session_id, tab_id })).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn floating_visible(app: AppHandle) -> bool {
    is_visible(&app)
}

#[tauri::command]
pub fn floating_hide(app: AppHandle) {
    hide(&app);
}

#[tauri::command]
pub fn floating_take_pending(app: AppHandle) -> Option<OpenTarget> {
    take_pending(&app)
}

#[tauri::command]
pub fn floating_open_in_main(app: AppHandle, session_id: String, tab_id: Option<String>) {
    open_in_main(&app, &OpenTarget { session_id, tab_id });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_become_accelerators_the_system_registers() {
        for (binding, expected) in [
            ("alt+shift+space", "Alt+Shift+Space"),
            ("mod+shift+k", "CommandOrControl+Shift+KeyK"),
            ("ctrl+alt+1", "Control+Alt+Digit1"),
            ("meta+/", "Super+Slash"),
            ("mod++", "CommandOrControl+Equal"),
            ("mod+plus", "CommandOrControl+Equal"),
            ("alt+f5", "Alt+F5"),
            ("  Mod+Shift+Enter ", "CommandOrControl+Shift+Enter"),
            ("ctrl+ctrl+up", "Control+ArrowUp"),
        ] {
            let accelerator = accelerator(binding).unwrap_or_else(|error| panic!("{binding}: {error}"));
            assert_eq!(accelerator, expected);
            // And the plugin's own parser takes every one of them.
            accelerator.parse::<Shortcut>().unwrap_or_else(|error| panic!("{accelerator}: {error}"));
        }
    }

    #[test]
    fn a_binding_that_would_swallow_typing_or_names_no_key_is_refused() {
        for binding in ["", "space", "shift+a", "alt+", "hold:AltRight", "hyper+k", "mod+f99", "mod+dead"] {
            assert!(accelerator(binding).is_err(), "{binding:?} was accepted");
        }
    }
}
