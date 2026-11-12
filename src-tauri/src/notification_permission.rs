//! Whether macOS lets TerminalX show its banners and dock badge.
//! tauri-plugin-notification answers "granted" on every desktop whatever the
//! system says, so the app asks UserNotifications itself. The answer is
//! "granted", "denied", "ask" (never decided) or "unknown": not macOS, a
//! build that is not an app bundle, or no answer in time. The frontend shows
//! its "Notifications are off" card for "denied" only.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Granted,
    Denied,
    Ask,
}

fn answer(status: Option<Status>) -> &'static str {
    match status {
        Some(Status::Granted) => "granted",
        Some(Status::Denied) => "denied",
        Some(Status::Ask) => "ask",
        None => "unknown",
    }
}

/// Blocks for up to two seconds on the system's answer: call it off the main thread.
pub fn permission() -> &'static str {
    answer(status())
}

#[cfg(all(target_os = "macos", feature = "desktop"))]
fn status() -> Option<Status> {
    use block2::RcBlock;
    use objc2_foundation::NSBundle;
    use objc2_user_notifications::{UNAuthorizationStatus, UNNotificationSettings, UNUserNotificationCenter};
    use std::{ptr::NonNull, sync::mpsc, time::Duration};

    // UNUserNotificationCenter raises for a process that is not an app bundle
    // (a bare binary from target/debug, even with an embedded Info.plist).
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier()?;
    if !bundle.bundlePath().to_string().ends_with(".app") {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: the system passes a valid settings object for the duration of the call.
        let _ = tx.send(unsafe { settings.as_ref() }.authorizationStatus());
    });
    UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&handler);
    Some(match rx.recv_timeout(Duration::from_secs(2)).ok()? {
        UNAuthorizationStatus::Denied => Status::Denied,
        UNAuthorizationStatus::NotDetermined => Status::Ask,
        // Authorized, Provisional and Ephemeral all deliver banners.
        _ => Status::Granted,
    })
}

#[cfg(not(all(target_os = "macos", feature = "desktop")))]
fn status() -> Option<Status> {
    None
}

#[cfg(test)]
mod tests {
    use super::{answer, Status};

    #[test]
    fn only_a_refusal_reads_as_denied() {
        assert_eq!(answer(Some(Status::Denied)), "denied");
        assert_eq!(answer(Some(Status::Granted)), "granted");
        assert_eq!(answer(Some(Status::Ask)), "ask");
        assert_eq!(answer(None), "unknown");
    }

    #[test]
    fn a_test_binary_is_not_an_app_bundle_and_is_never_called_denied() {
        // cargo test runs a bare binary: the guard must answer before UserNotifications is touched.
        assert_eq!(super::permission(), "unknown");
    }
}
