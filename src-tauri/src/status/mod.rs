//! App-wide status chrome.
//!
//! The preference belongs to the native side because the macOS View menu and
//! the webview switch are two controls for the same persisted value. Runtime
//! usage and process state join this module without becoming durable data.

use anyhow::Result;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuItemKind};
use tauri::{App, AppHandle, Emitter, Runtime};

pub const MENU_ID: &str = "status-bar-visible";
pub const SETTINGS_EVENT: &str = "status_bar_settings";

pub fn install_menu(app: &App) -> Result<()> {
    let menu = Menu::default(app.handle())?;
    let checked = crate::store::settings::load().status_bar.visible;
    let item = CheckMenuItemBuilder::with_id(MENU_ID, "Status Bar").checked(checked).build(app)?;
    for entry in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = entry {
            if submenu.text()?.as_str() == "View" {
                submenu.append(&item)?;
                break;
            }
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

pub fn set_menu_checked<R: Runtime>(app: &AppHandle<R>, checked: bool) {
    let Some(menu) = app.menu() else { return };
    for entry in menu.items().unwrap_or_default() {
        let MenuItemKind::Submenu(submenu) = entry else { continue };
        let Some(MenuItemKind::Check(item)) = submenu.get(MENU_ID) else { continue };
        let _ = item.set_checked(checked);
        return;
    }
}

pub fn toggle_from_menu(app: &AppHandle) {
    let mut settings = crate::store::settings::load();
    settings.status_bar.visible = !settings.status_bar.visible;
    if let Err(error) = crate::store::settings::save(&settings) {
        log::warn!("save status bar setting: {error:#}");
        return;
    }
    set_menu_checked(app, settings.status_bar.visible);
    let _ = app.emit(SETTINGS_EVENT, &settings.status_bar);
}
