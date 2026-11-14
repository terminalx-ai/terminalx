//! macOS Reduce transparency (System Settings → Accessibility → Display), for
//! the webviews (PRO-336).
//!
//! WebKit does not implement `prefers-reduced-transparency`: in a WKWebView
//! every form of the query reports false, whatever the setting. AppKit is the
//! source instead. Each webview learns the setting before its first paint, from
//! a script this plugin installs, and is told when it changes while the app
//! runs. A webview opened later asks [`reduce_transparency`] on load, since the
//! script carries the value from launch.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Emitter, Runtime};

/// The event every webview hears when the setting changes, with the new value.
pub const CHANGED: &str = "reduce_transparency_changed";

/// The global index.html reads before it turns glass mode on.
pub const GLOBAL: &str = "__TERMINALX_REDUCE_TRANSPARENCY__";

/// What runs in each webview before the page's own scripts.
pub fn init_script(reduce: bool) -> String {
    format!("window.{GLOBAL} = {reduce};")
}

/// Whether the reader asks macOS to Reduce transparency. False elsewhere.
#[tauri::command]
pub fn reduce_transparency() -> bool {
    platform::reduce()
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("reduce-transparency")
        .js_init_script(init_script(platform::reduce()))
        .setup(|app, _| {
            let app = app.clone();
            platform::watch(move |reduce| {
                if let Err(error) = app.emit(CHANGED, reduce) {
                    log::warn!("tell the windows about Reduce transparency: {error}");
                }
            });
            Ok(())
        })
        .build()
}

#[cfg(target_os = "macos")]
mod platform {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification};
    use objc2_foundation::{NSNotification, NSOperationQueue};
    use std::ptr::NonNull;

    pub fn reduce() -> bool {
        NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
    }

    /// Calls `changed` on the main queue each time the display options change,
    /// for as long as the app runs.
    pub fn watch(changed: impl Fn(bool) + 'static) {
        let block = RcBlock::new(move |_: NonNull<NSNotification>| changed(reduce()));
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: the name is AppKit's own constant, the block takes the
        // notification it is declared to take, and the main queue runs it.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };
        // Observed for the app's life: the center keeps the block while the token lives.
        std::mem::forget(observer);
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn reduce() -> bool {
        false
    }

    pub fn watch(_changed: impl Fn(bool) + 'static) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_sets_the_global_index_html_reads() {
        assert_eq!(init_script(true), "window.__TERMINALX_REDUCE_TRANSPARENCY__ = true;");
        assert_eq!(init_script(false), "window.__TERMINALX_REDUCE_TRANSPARENCY__ = false;");
        let html = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../index.html")).unwrap();
        assert!(html.contains(GLOBAL), "index.html reads {GLOBAL}");
    }

}
