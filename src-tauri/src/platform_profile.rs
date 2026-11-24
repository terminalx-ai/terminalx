//! What the app calls the computer it runs on, and the other words that
//! depend on its system: one table, `packages/portable/src/platformProfiles.json`,
//! that the window reads too, so a message from the runtime and the screen
//! around it say "this PC" alike.
//!
//! The desktop also tells each webview which system it runs on before the
//! page's own scripts run (`window.__TERMINALX_PLATFORM__`), so the window
//! never has to guess it from the browser.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

/// One system's words, as the table has them: those the runtime's own
/// messages use. The window reads the rest (icon, keys, settings paths).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformProfile {
    pub computer_word: String,
    pub this_computer: String,
    #[serde(rename = "ThisComputer")]
    pub this_computer_capitalised: String,
    pub your_computer: String,
    pub secret_store: Option<String>,
    pub secret_store_the: String,
    pub secret_store_short: String,
    pub secret_store_word: String,
}

static PROFILES: LazyLock<HashMap<String, PlatformProfile>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../packages/portable/src/platformProfiles.json")).expect("valid platform profiles")
});

/// The system this build runs on, as Rust names it: `macos`, `windows`, `linux`.
pub const FAMILY: &str = std::env::consts::OS;

/// The profile for `family`; a system the table does not list is spoken of by
/// plain nouns, as Linux is.
pub fn profile_for(family: &str) -> &'static PlatformProfile {
    PROFILES.get(family).or_else(|| PROFILES.get("linux")).expect("a linux profile")
}

/// This computer's profile.
pub fn current() -> &'static PlatformProfile {
    profile_for(FAMILY)
}

/// `text`, written as a Mac reads it, in this computer's words: "this Mac"
/// becomes "this PC" on Windows and "this computer" on Linux; on a Mac it is
/// returned as written. Only whole phrases change, so "Mac mini" and "macOS"
/// are left alone.
pub fn localize(text: &str) -> String {
    localize_for(current(), text)
}

/// [`localize`] for a fixed message that must stay `&'static str` (a match
/// arm, a constant's value). Each distinct message is localized once and
/// kept: these are a fixed set written in the source, so the store cannot grow.
pub fn localize_static(text: &'static str) -> &'static str {
    static DONE: LazyLock<std::sync::Mutex<HashMap<&'static str, &'static str>>> = LazyLock::new(Default::default);
    if FAMILY == "macos" {
        return text;
    }
    let mut done = DONE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    done.entry(text).or_insert_with(|| Box::leak(localize(text).into_boxed_str()))
}

/// [`localize`] for the system `profile` describes.
pub fn localize_for(profile: &PlatformProfile, text: &str) -> String {
    // " mini" is matched too so that a Mac mini, a product, keeps its name;
    // "Keychain Access", the Mac's own app, keeps its name the same way.
    static PHRASE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\b(This|this|your|the) Mac\b( mini\b)?|\b(the macOS|macOS|the)? ?Keychain\b( Access\b| on a Mac\b)?").expect("valid phrase pattern")
    });
    PHRASE
        .replace_all(text, |caps: &regex::Captures| {
            if caps.get(2).is_some() || caps.get(4).is_some() {
                return caps[0].to_string();
            }
            if let Some(noun) = caps.get(1) {
                return match noun.as_str() {
                    "This" => profile.this_computer_capitalised.clone(),
                    "this" => profile.this_computer.clone(),
                    "your" => profile.your_computer.clone(),
                    _ => format!("the {}", profile.computer_word),
                };
            }
            let lead = if caps[0].starts_with(' ') { " " } else { "" };
            let store = match caps.get(3).map(|article| article.as_str()) {
                Some("the macOS") => profile.secret_store_the.clone(),
                Some("macOS") => profile.secret_store.clone().unwrap_or_else(|| "No secret store on this system".into()),
                Some("the") => profile.secret_store_short.clone(),
                _ => profile.secret_store_word.clone(),
            };
            format!("{lead}{store}")
        })
        .into_owned()
}

/// The global each webview reads for its system, set before its own scripts.
#[cfg(feature = "desktop")]
pub const GLOBAL: &str = "__TERMINALX_PLATFORM__";

/// What runs in each webview before the page's own scripts.
#[cfg(feature = "desktop")]
pub fn init_script() -> String {
    format!("window.{GLOBAL} = {};", serde_json::Value::from(FAMILY))
}

#[cfg(feature = "desktop")]
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("platform-profile").js_init_script(init_script()).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_system_the_app_runs_on_has_a_profile_with_every_word() {
        for family in ["macos", "windows", "linux"] {
            let profile = PROFILES.get(family).unwrap_or_else(|| panic!("no {family} profile"));
            for word in [&profile.computer_word, &profile.this_computer, &profile.this_computer_capitalised, &profile.your_computer, &profile.secret_store_short, &profile.secret_store_word] {
                assert!(!word.is_empty(), "{family}: an empty word");
            }
            assert!(profile.this_computer_capitalised.starts_with(char::is_uppercase), "{family}: {}", profile.this_computer_capitalised);
        }
        assert_eq!(PROFILES.len(), 3, "a profile for a system this app does not build for");
    }

    #[test]
    fn the_words_follow_the_system_and_an_unknown_one_reads_as_a_plain_computer() {
        assert_eq!(profile_for("macos").this_computer, "this Mac");
        assert_eq!(profile_for("windows").this_computer, "this PC");
        assert_eq!(profile_for("linux").this_computer, "this computer");
        assert_eq!(profile_for("freebsd").this_computer, "this computer");
        assert_eq!(current().this_computer, profile_for(std::env::consts::OS).this_computer);
    }

    #[test]
    fn a_message_written_for_a_mac_reads_in_each_systems_words() {
        let text = "This Mac's login. Run it on this Mac, or open it on your Mac; the Mac mini and macOS stay.";
        assert_eq!(localize_for(profile_for("macos"), text), text);
        assert_eq!(localize_for(profile_for("windows"), text), "This PC's login. Run it on this PC, or open it on your PC; the Mac mini and macOS stay.");
        assert_eq!(localize_for(profile_for("linux"), "The image is no longer on the Mac."), "The image is no longer on the computer.");
        assert_eq!(localize_for(profile_for("windows"), "MacBook, iMac and Macs"), "MacBook, iMac and Macs");
    }

    #[test]
    fn the_secret_store_is_named_as_each_system_keeps_it() {
        let text = "Check Keychain access. Kept in the Keychain, the macOS Keychain or macOS Keychain; open Keychain Access; the Keychain on a Mac.";
        assert_eq!(localize_for(profile_for("macos"), text), text);
        assert_eq!(
            localize_for(profile_for("windows"), text),
            "Check Encrypted store access. Kept in the Windows encrypted store, the Windows encrypted store or Windows encrypted store; open Keychain Access; the Keychain on a Mac."
        );
        assert_eq!(localize_for(profile_for("linux"), "Saved to the Keychain."), "Saved to the secret store.");
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn each_webview_learns_its_system_before_its_scripts_run() {
        assert_eq!(init_script(), format!("window.__TERMINALX_PLATFORM__ = \"{}\";", std::env::consts::OS));
    }
}
