//! Keeping this Mac from idle sleep while something needs it awake.
//!
//! An [`Assertion`] is one IOKit `PreventUserIdleSystemSleep` assertion with a
//! named [`Reason`], held from [`Assertion::hold`] until it is dropped. Each
//! feature holds its own: a connected phone (PRO-314) holds
//! [`PHONE_CONNECTED`]; agents at work (PRO-151) can hold theirs beside it.
//! The display may still sleep, and the person can still put the Mac to sleep.
//!
//! [`held`] reports what this process holds now, so callers and tests read
//! the module's own state instead of asking the system. Elsewhere than macOS
//! holding is a no-op that is still tracked.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::Result;

/// Why the Mac is kept awake, as `pmset -g assertions` shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Reason(&'static str);

impl Reason {
    pub const fn new(text: &'static str) -> Self {
        Self(text)
    }

    pub fn text(&self) -> &'static str {
        self.0
    }
}

/// A phone is connected (docs/PAIRING-APPROVAL.md, "Keep this Mac awake").
pub const PHONE_CONNECTED: Reason = Reason::new("A phone is connected to TerminalX");

/// One assertion this process holds, as [`held`] lists it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Held {
    pub serial: u64,
    pub reason: Reason,
    /// The IOKit assertion id; `None` where there is no IOKit.
    pub id: Option<u32>,
}

static HELD: Mutex<Vec<Held>> = Mutex::new(Vec::new());
static SERIAL: AtomicU64 = AtomicU64::new(1);

/// Every assertion this process holds now.
pub fn held() -> Vec<Held> {
    HELD.lock().unwrap().clone()
}

/// Kept awake for `reason` until dropped.
#[derive(Debug)]
pub struct Assertion {
    held: Held,
}

impl Assertion {
    pub fn hold(reason: Reason) -> Result<Self> {
        let id = platform::create(reason.text())?;
        let held = Held {
            serial: SERIAL.fetch_add(1, Ordering::Relaxed),
            reason,
            id,
        };
        HELD.lock().unwrap().push(held);
        Ok(Self { held })
    }

    pub fn reason(&self) -> Reason {
        self.held.reason
    }

    pub fn serial(&self) -> u64 {
        self.held.serial
    }

    /// The id IOKit returned; `None` where there is no IOKit.
    pub fn id(&self) -> Option<u32> {
        self.held.id
    }
}

impl Drop for Assertion {
    fn drop(&mut self) {
        HELD.lock().unwrap().retain(|held| held.serial != self.held.serial);
        if let Some(id) = self.held.id {
            platform::release(id);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void, CString};

    use anyhow::{bail, Result};

    type CFStringRef = *const c_void;
    type IOPMAssertionID = u32;
    type IOReturn = i32;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
    const K_IO_RETURN_SUCCESS: IOReturn = 0;
    /// `kIOPMAssertionTypePreventUserIdleSystemSleep`.
    const PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: *const c_void, text: *const c_char, encoding: u32) -> CFStringRef;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            id: *mut IOPMAssertionID,
        ) -> IOReturn;
        fn IOPMAssertionRelease(id: IOPMAssertionID) -> IOReturn;
    }

    /// An owned CFString, released on drop.
    struct CfString(CFStringRef);

    impl CfString {
        fn new(text: &str) -> Result<Self> {
            let text = CString::new(text)?;
            // SAFETY: `text` is a NUL-terminated UTF-8 string that outlives the call.
            let value = unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), K_CF_STRING_ENCODING_UTF8) };
            if value.is_null() {
                bail!("could not make a CFString");
            }
            Ok(Self(value))
        }
    }

    impl Drop for CfString {
        fn drop(&mut self) {
            // SAFETY: made by CFStringCreateWithCString and released once.
            unsafe { CFRelease(self.0) }
        }
    }

    pub(super) fn create(reason: &str) -> Result<Option<u32>> {
        let kind = CfString::new(PREVENT_USER_IDLE_SYSTEM_SLEEP)?;
        let name = CfString::new(reason)?;
        let mut id: IOPMAssertionID = 0;
        // SAFETY: both strings are valid CFStrings for the call; `id` is a valid out pointer.
        let result = unsafe { IOPMAssertionCreateWithName(kind.0, K_IOPM_ASSERTION_LEVEL_ON, name.0, &mut id) };
        if result != K_IO_RETURN_SUCCESS {
            bail!("IOPMAssertionCreateWithName failed ({result:#x})");
        }
        Ok(Some(id))
    }

    pub(super) fn release(id: u32) {
        // SAFETY: `id` came from IOPMAssertionCreateWithName and is released once.
        let result = unsafe { IOPMAssertionRelease(id) };
        if result != K_IO_RETURN_SUCCESS {
            log::warn!("IOPMAssertionRelease failed ({result:#x})");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use anyhow::Result;

    pub(super) fn create(_reason: &str) -> Result<Option<u32>> {
        Ok(None)
    }

    pub(super) fn release(_id: u32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST: Reason = Reason::new("TerminalX power module test");

    #[test]
    fn an_assertion_is_held_until_it_is_dropped() {
        let first = Assertion::hold(TEST).unwrap();
        let second = Assertion::hold(PHONE_CONNECTED).unwrap();
        #[cfg(target_os = "macos")]
        {
            assert!(first.id().is_some_and(|id| id != 0), "IOKit returned no assertion id");
            assert!(second.id().is_some());
            assert_ne!(first.id(), second.id());
        }
        let mine = |serial: u64| held().into_iter().find(|held| held.serial == serial);
        assert_eq!(mine(first.serial()).map(|held| (held.reason, held.id)), Some((TEST, first.id())));
        assert_eq!(mine(second.serial()).map(|held| held.reason), Some(PHONE_CONNECTED));
        assert_eq!(first.reason().text(), "TerminalX power module test");

        let (first_serial, second_serial) = (first.serial(), second.serial());
        drop(first);
        assert!(mine(first_serial).is_none());
        assert!(mine(second_serial).is_some());
        drop(second);
        assert!(mine(second_serial).is_none());
    }
}
