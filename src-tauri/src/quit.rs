//! Asking before the app goes while something must not be cut short.
//!
//! The web view says when such work is under way (a worktree clean-up) and
//! when it is over. While it is, closing the main window or quitting asks
//! first. Agreeing quits; anything else leaves the app as it was.
//!
//! Only a quit this process is asked about can be held back: the Quit menu
//! item and Cmd+Q, the tray's Quit, and the main window's close button.
//! Quitting from the Dock, logging out or shutting down ends the process
//! without asking it. A restart for an update is not held back either.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_dialog::MessageDialogResult;

/// The app menu's own Quit item, see [`own_quit_item`].
pub const MENU_ID: &str = "app-quit";

const QUIT: &str = "Quit Anyway";
const STAY: &str = "Keep Running";

/// What quitting now would cut short.
#[derive(Default)]
pub struct QuitGuard {
    /// In words for the person. `None`: nothing is under way.
    warning: Mutex<Option<String>>,
    /// The question is on screen.
    asking: AtomicBool,
    /// They said to quit anyway.
    agreed: AtomicBool,
}

static GUARD: QuitGuard = QuitGuard { warning: Mutex::new(None), asking: AtomicBool::new(false), agreed: AtomicBool::new(false) };

impl QuitGuard {
    /// Say what is under way, or with `None` that it is over.
    pub fn set(&self, warning: Option<String>) {
        *self.warning.lock().unwrap() = warning.filter(|warning| !warning.trim().is_empty());
        // An answer was about the work that was under way then.
        self.agreed.store(false, Ordering::SeqCst);
    }

    /// What to ask before quitting now. `None` when nothing is under way, or
    /// they already said to quit.
    fn pending(&self) -> Option<String> {
        if self.agreed.load(Ordering::SeqCst) {
            return None;
        }
        self.warning.lock().unwrap().clone()
    }
}

/// Only the explicit button quits. A dismissal (Escape, the close box) is
/// reported as the other one.
fn agreed(pressed: &MessageDialogResult) -> bool {
    matches!(pressed, MessageDialogResult::Custom(label) if label == QUIT)
}

/// The web view names the work that quitting would cut short, or clears it.
#[tauri::command]
pub fn set_quit_warning(warning: Option<String>) {
    GUARD.set(warning);
}

/// Whether a quit, or a close of the main window, is held back for now. When
/// it is, the person is asked, once however often they try, and agreeing
/// quits.
pub fn held(app: &AppHandle) -> bool {
    let Some(warning) = GUARD.pending() else { return false };
    if !GUARD.asking.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            let pressed = app
                .dialog()
                .message(warning)
                .title(format!("Quit {}?", app.package_info().name))
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(QUIT.to_string(), STAY.to_string()))
                .blocking_show_with_result();
            GUARD.asking.store(false, Ordering::SeqCst);
            // It may have finished while the question was up: then there is
            // nothing left to cut short, and quitting is what was asked for.
            if agreed(&pressed) {
                GUARD.agreed.store(true, Ordering::SeqCst);
                app.exit(0);
            }
        });
    }
    true
}

/// Put a Quit item this app answers in place of the system's, which on macOS
/// ends the process without asking it anything. The menu is left as it is
/// when it is not laid out as expected, and quitting then works as before.
#[cfg(target_os = "macos")]
pub fn own_quit_item<R: tauri::Runtime>(app: &AppHandle<R>, menu: &tauri::menu::Menu<R>) -> tauri::Result<()> {
    use tauri::menu::{MenuItemBuilder, MenuItemKind};
    let Some(MenuItemKind::Submenu(application)) = menu.items()?.into_iter().next() else { return Ok(()) };
    let Some(MenuItemKind::Predefined(system)) = application.items()?.into_iter().last() else { return Ok(()) };
    if !system.text()?.contains("Quit") {
        return Ok(());
    }
    let own = MenuItemBuilder::with_id(MENU_ID, format!("Quit {}", app.package_info().name)).accelerator("CmdOrCtrl+Q").build(app)?;
    application.remove(&system)?;
    application.append(&own)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quit_is_asked_about_only_while_something_is_under_way() {
        let guard = QuitGuard::default();
        assert_eq!(guard.pending(), None);
        guard.set(Some("A worktree clean-up is still running.".into()));
        assert_eq!(guard.pending().as_deref(), Some("A worktree clean-up is still running."));
        // Once they agreed, the quit that follows is not asked about again.
        guard.agreed.store(true, Ordering::SeqCst);
        assert_eq!(guard.pending(), None);
        // That answer does not cover the next piece of work.
        guard.set(Some("Another one is running.".into()));
        assert!(guard.pending().is_some());
        guard.set(None);
        assert_eq!(guard.pending(), None);
        guard.set(Some("  ".into()));
        assert_eq!(guard.pending(), None, "nothing to say is nothing under way");
    }

    #[test]
    fn only_the_explicit_button_quits() {
        assert!(agreed(&MessageDialogResult::Custom(QUIT.into())));
        // Escape and the close box come back as the other button.
        for other in [MessageDialogResult::Custom(STAY.into()), MessageDialogResult::Cancel, MessageDialogResult::No, MessageDialogResult::Ok, MessageDialogResult::Yes] {
            assert!(!agreed(&other), "{other:?}");
        }
    }
}
