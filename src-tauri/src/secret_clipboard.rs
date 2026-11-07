//! Environment copies are concealed from clipboard history and expire without
//! reading the clipboard or retaining the secret for the expiry timer.
use anyhow::Result;

#[cfg(any(target_os = "macos", test))]
trait Clipboard: Send + Sync + 'static {
    fn write_secret(&self, text: &str) -> Result<isize>;
    fn change_count(&self) -> isize;
    fn clear(&self);
}

#[cfg(any(target_os = "macos", test))]
fn expire(clipboard: &impl Clipboard, copied: isize) {
    // A later copy, even of identical text, belongs to the user and survives.
    if clipboard.change_count() == copied { clipboard.clear(); }
}

#[cfg(target_os = "macos")]
struct SystemClipboard;

#[cfg(target_os = "macos")]
impl Clipboard for SystemClipboard {
    fn write_secret(&self, text: &str) -> Result<isize> {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        // Mark before writing text so clipboard-history tools can skip it.
        anyhow::ensure!(board.setString_forType(&NSString::from_str(""), &NSString::from_str("org.nspasteboard.ConcealedType")), "Could not conceal the clipboard item.");
        // SAFETY: NSPasteboardTypeString is an immutable AppKit string constant.
        if !board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
            board.clearContents();
            anyhow::bail!("Could not copy the environment value.");
        }
        Ok(board.changeCount())
    }
    fn change_count(&self) -> isize { objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() }
    fn clear(&self) { objc2_app_kit::NSPasteboard::generalPasteboard().clearContents(); }
}

#[cfg(target_os = "macos")]
pub fn copy(text: &str) -> Result<()> {
    static COPIES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _copy = COPIES.lock().unwrap();
    let copied = SystemClipboard.write_secret(text)?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let _copy = COPIES.lock().unwrap();
        expire(&SystemClipboard, copied);
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn copy(_text: &str) -> Result<()> {
    anyhow::bail!("Concealed environment copies are available on macOS.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Board(Mutex<(isize, String)>);
    impl Clipboard for Board {
        fn write_secret(&self, text: &str) -> Result<isize> {
            let mut value = self.0.lock().unwrap();
            value.0 += 1;
            value.1 = text.into();
            Ok(value.0)
        }
        fn change_count(&self) -> isize { self.0.lock().unwrap().0 }
        fn clear(&self) { let mut value = self.0.lock().unwrap(); value.0 += 1; value.1.clear(); }
    }
    #[test]
    fn expiry_clears_the_secret_but_preserves_any_later_copy_even_if_identical() {
        let board = Board::default();
        let copied = board.write_secret("secret").unwrap();
        expire(&board, copied);
        assert!(board.0.lock().unwrap().1.is_empty());
        let earlier = board.write_secret("same").unwrap();
        let later = board.write_secret("same").unwrap();
        expire(&board, earlier);
        assert_eq!(board.0.lock().unwrap().1, "same");
        expire(&board, later);
        assert!(board.0.lock().unwrap().1.is_empty());
    }
}
