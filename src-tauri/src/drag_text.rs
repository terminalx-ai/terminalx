//! The text of a drag that ended on the window.
//!
//! The webview's drag-drop event carries file paths and nothing else, and it
//! takes every drag before the page sees it, so text dragged from another
//! app arrives as a drop with no paths. The system keeps what was dragged on
//! the drag pasteboard, which is read here at the moment of such a drop and
//! handed out once: the page cannot read what was dragged at any other time,
//! nor read the same drop twice.

use std::sync::Mutex;

static DROPPED: Mutex<Option<String>> = Mutex::new(None);

fn set(text: Option<String>) {
    *DROPPED.lock().unwrap_or_else(|e| e.into_inner()) = text;
}

/// Follow the window's drags: a new drag forgets the last one's text, and a
/// drop that carries no files keeps its text for the drop handler.
pub fn on_drag_drop(event: &tauri::DragDropEvent) {
    match event {
        tauri::DragDropEvent::Drop { paths, .. } if paths.is_empty() => set(pasteboard_text()),
        tauri::DragDropEvent::Over { .. } => {}
        _ => set(None),
    }
}

/// The plain text of the drop that just happened, once.
#[tauri::command]
pub fn dropped_text() -> Option<String> {
    DROPPED.lock().unwrap_or_else(|e| e.into_inner()).take()
}

#[cfg(target_os = "macos")]
fn pasteboard_text() -> Option<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeString};
    let text = unsafe {
        let pasteboard = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
        pasteboard.stringForType(NSPasteboardTypeString)
    }?
    .to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(not(target_os = "macos"))]
fn pasteboard_text() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_of_a_drop_is_handed_out_once_and_a_new_drag_forgets_it() {
        assert_eq!(dropped_text(), None);
        set(Some("echo hi".into()));
        assert_eq!(dropped_text().as_deref(), Some("echo hi"));
        assert_eq!(dropped_text(), None);

        set(Some("stale".into()));
        on_drag_drop(&tauri::DragDropEvent::Leave);
        assert_eq!(dropped_text(), None);
    }
}
