//! The native presentation of the frontend action registry. No commands or
//! bindings are duplicated here: an item sends its action ID to its owner.

use serde::Deserialize;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Section {
    App,
    File,
    View,
    Go,
    Help,
}

#[derive(Deserialize)]
pub struct Group {
    id: Section,
    items: Vec<Item>,
}

#[derive(Deserialize)]
pub struct Item {
    id: String,
    text: String,
    accelerator: Option<String>,
    separator: bool,
    children: Option<Vec<Item>>,
}

fn append(app: &AppHandle, menu: &Submenu<tauri::Wry>, items: &[Item]) -> tauri::Result<()> {
    for item in items {
        if item.separator {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        if let Some(children) = &item.children {
            let submenu = Submenu::new(app, &item.text, true)?;
            append(app, &submenu, children)?;
            menu.append(&submenu)?;
        } else {
            menu.append(&MenuItem::with_id(app, &item.id, &item.text, true, item.accelerator.as_deref())?)?;
        }
    }
    Ok(())
}

/// Called after the webview has loaded preferences, and whenever its menu
/// projection changes. Async keeps menu construction off the event loop.
#[tauri::command]
pub async fn set_native_menu(app: AppHandle, window: WebviewWindow, groups: Vec<Group>) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window owns the application menu".into());
    }
    build(&app, &groups).map_err(|error| error.to_string())
}

fn build(app: &AppHandle, groups: &[Group]) -> tauri::Result<()> {
    let defaults = Menu::default(app)?;
    #[cfg(target_os = "macos")]
    crate::quit::own_quit_item(app, &defaults)?;
    let entries = defaults.items()?;
    let menu = Menu::new(app)?;
    for group in groups {
        let (id, title) = match group.id {
            Section::App => ("application", app.package_info().name.as_str()),
            Section::File => ("file", "File"),
            Section::View => ("view", "View"),
            Section::Go => ("go", "Go"),
            Section::Help => (tauri::menu::HELP_SUBMENU_ID, "Help"),
        };
        let submenu = Submenu::with_id(app, id, title, true)?;
        append(app, &submenu, &group.items)?;
        if matches!(group.id, Section::App) {
            #[cfg(target_os = "macos")]
            if let Some(MenuItemKind::Submenu(application)) = entries.first() {
                // Preserve Services, Hide, and guarded Quit; About is an app action now.
                for item in application.items()?.iter().skip(1) {
                    submenu.append(item)?;
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                submenu.append(&PredefinedMenuItem::separator(app)?)?;
                submenu.append(&MenuItem::with_id(app, crate::quit::STOP_ALL_MENU_ID, "Stop all and quit", true, None::<&str>)?)?;
                submenu.append(&MenuItem::with_id(app, crate::quit::MENU_ID, "Quit", true, Some("Alt+F4"))?)?;
            }
        }
        if matches!(group.id, Section::View) {
            submenu.append(&PredefinedMenuItem::separator(app)?)?;
            submenu.append(&CheckMenuItemBuilder::with_id(crate::status::MENU_ID, "Status Bar")
                .checked(crate::store::settings::load().status_bar.visible).build(app)?)?;
        }
        menu.append(&submenu)?;
        if matches!(group.id, Section::File) {
            for entry in &entries {
                if let MenuItemKind::Submenu(edit) = entry {
                    if edit.text()? == "Edit" {
                        menu.append(edit)?;
                    }
                }
            }
        }
        if matches!(group.id, Section::Go) {
            // Keep the system Window menu, but not its hard-coded Cmd+W:
            // Close Tab and Close Window have their own rebindable actions.
            let windows = Submenu::with_id(app, tauri::menu::WINDOW_SUBMENU_ID, "Window", true)?;
            windows.append(&PredefinedMenuItem::minimize(app, None)?)?;
            windows.append(&PredefinedMenuItem::maximize(app, None)?)?;
            menu.append(&windows)?;
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

/// A menu event goes to exactly one webview. Session/window commands belong
/// to the focused window; workbench commands bring the main window forward.
pub fn dispatch(app: &AppHandle, id: &str) {
    let Some((focused, action)) = destination(id) else { return };
    let window = if focused {
        app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false))
    } else {
        app.get_webview_window("main")
    };
    if let Some(window) = window {
        if !focused {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = window.emit_to(window.label(), "native-menu-action", action);
    }
}

fn destination(id: &str) -> Option<(bool, &str)> {
    if let Some(action) = id.strip_prefix("command:focused:") {
        Some((true, action))
    } else if let Some(action) = id.strip_prefix("command:main:") {
        Some((false, action))
    } else if id.starts_with("recent:") {
        Some((false, id))
    } else {
        None
    }
}

#[tauri::command]
pub async fn native_window_action(window: WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "close" => window.close(),
        "fullscreen" => window.is_fullscreen().and_then(|full| window.set_fullscreen(!full)),
        _ => return Err("Unknown window action".into()),
    }.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_have_one_owner_and_unrelated_menus_are_ignored() {
        assert_eq!(destination("command:focused:session.closeTab"), Some((true, "session.closeTab")));
        assert_eq!(destination("command:main:app.settings"), Some((false, "app.settings")));
        assert_eq!(destination("recent:/path:with:colons"), Some((false, "recent:/path:with:colons")));
        assert_eq!(destination(crate::quit::MENU_ID), None);
        assert_eq!(destination(crate::status::MENU_ID), None);
    }
}
