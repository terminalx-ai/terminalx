//! The text of a drag that ended on the window.
//!
//! The webview's drag-drop event carries file paths and nothing else, and it
//! takes every drag before the page sees it, so text dragged from another
//! app arrives as a drop with no paths. The system keeps what was dragged on
//! the drag pasteboard until the next drag starts, which is where a terminal
//! reads it from to paste it.

/// The plain text of the last drag, if it carried any.
#[tauri::command]
pub fn dropped_text() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeString};
        let text = unsafe {
            let pasteboard = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
            pasteboard.stringForType(NSPasteboardTypeString)
        }?
        .to_string();
        (!text.is_empty()).then_some(text)
    }
    #[cfg(not(target_os = "macos"))]
    None
}
