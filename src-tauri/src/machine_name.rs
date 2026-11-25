//! This computer's name as TerminalX shows it to the person's other devices
//! (#686): chosen in Settings, or the computer's own. Shared by the desktop's
//! pairing and the runtime, which names its machine in `machine.describe`
//! (PRO-340) with no window to ask.

use std::sync::Mutex;

use crate::local_runtime::mobile::model::MachineName;

/// The longest computer name sent to a phone.
pub(crate) const COMPUTER_NAME_MAX_CHARS: usize = 64;

/// A name as it may be shown on another device: no control or formatting
/// characters, single spaces, at most [`COMPUTER_NAME_MAX_CHARS`]. `None`
/// when nothing is left.
pub(crate) fn presentable_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control() && !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
        .collect();
    let name: String = cleaned.split(' ').filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ").chars().take(COMPUTER_NAME_MAX_CHARS).collect();
    let name = name.trim_end().to_string();
    (!name.is_empty()).then_some(name)
}

/// This computer's own name: the macOS computer name (System Settings →
/// General → About → Name), the host name elsewhere. Read each time it is
/// asked for, so a rename shows on the next connection.
pub(crate) fn computer_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        if output.status.success() {
            if let Some(name) = String::from_utf8(output.stdout).ok().and_then(|name| presentable_name(&name)) {
                return Some(name);
            }
        }
    }
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .chain(std::fs::read_to_string("/etc/hostname").ok())
        .filter_map(|name| presentable_name(name.split('.').next().unwrap_or("")))
        .next()
        .or_else(system_host_name)
}

/// [`computer_name`], read again once it is a minute old: the work-status
/// publisher asks for this Mac's name on each pass.
pub(crate) fn recent_computer_name() -> Option<String> {
    const FRESH_FOR: std::time::Duration = std::time::Duration::from_secs(60);
    static RECENT: Mutex<Option<(std::time::Instant, Option<String>)>> = Mutex::new(None);
    let mut recent = RECENT.lock().unwrap();
    if let Some((at, name)) = recent.as_ref() {
        if at.elapsed() < FRESH_FOR {
            return name.clone();
        }
    }
    let name = computer_name();
    *recent = Some((std::time::Instant::now(), name.clone()));
    name
}

/// The kernel's host name ("Studio.local" → "Studio"), for when nothing else
/// names this computer. "localhost" names every computer, so it is no name.
#[cfg(unix)]
fn system_host_name() -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: the call writes at most `buffer.len()` bytes into a buffer that outlives it.
    if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
        return None;
    }
    let end = buffer.iter().position(|&byte| byte == 0).unwrap_or(buffer.len());
    let name = String::from_utf8_lossy(&buffer[..end]);
    presentable_name(name.split('.').next().unwrap_or("")).filter(|name| !name.eq_ignore_ascii_case("localhost"))
}

#[cfg(not(unix))]
fn system_host_name() -> Option<String> {
    None
}

/// The name every Mac saved as its own before #686 when it was opened from
/// Finder or the Dock, which leaves no `HOSTNAME` to read. Nobody chose it,
/// and on another computer it says the opposite of what is true.
pub(crate) const PLACEHOLDER_HOST_NAME: &str = "This Mac";

/// What others are shown when nothing names this computer.
#[cfg(target_os = "macos")]
pub(crate) const UNNAMED_HOST: &str = "Unnamed Mac";
#[cfg(windows)]
pub(crate) const UNNAMED_HOST: &str = "Unnamed PC";
#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) const UNNAMED_HOST: &str = "Unnamed computer";

/// This Mac's name: the one chosen in Settings → Account, else one an earlier
/// version saved, else the computer's own. `chosen` when it does not follow
/// the computer's name.
pub(crate) fn resolve_machine_name(chosen: Option<String>, saved: Option<String>, computer_name: Option<String>) -> MachineName {
    let chosen = chosen.map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
    let (name, chosen) = match (chosen, saved) {
        (Some(name), _) => (name, true),
        (None, Some(name)) => {
            let differs = computer_name.as_deref() != Some(name.as_str());
            (name, differs)
        }
        (None, None) => (computer_name.clone().unwrap_or_else(|| UNNAMED_HOST.into()), false),
    };
    MachineName { name, chosen, computer_name }
}


/// This computer's name with no account to ask: the one chosen in Settings,
/// else one an earlier version saved in `account.json` for whoever is signed
/// in there, else the computer's own. The desktop reads the same values with
/// the signed-in account (`PairingManager::machine_name`).
pub(crate) fn current() -> MachineName {
    resolve_machine_name(crate::store::settings::load().machine_name, saved_in_account_mirror(), recent_computer_name())
}

/// The name an earlier version kept in `account.json`, never the placeholder
/// it saved when it found none.
fn saved_in_account_mirror() -> Option<String> {
    let path = crate::store::root().ok()?.join("account.json");
    let mirror: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    mirror.get("userId").and_then(serde_json::Value::as_str).filter(|user| !user.is_empty())?;
    mirror
        .get("hostDisplayName")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != PLACEHOLDER_HOST_NAME)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runtime_names_its_machine_as_settings_and_an_earlier_save_do() {
        let _home = crate::store::temp_home();
        let own = recent_computer_name();
        assert_eq!(current().name, own.clone().unwrap_or_else(|| UNNAMED_HOST.into()));
        crate::store::write_json(&crate::store::root().unwrap().join("account.json"), &serde_json::json!({ "userId": "u1", "hostDisplayName": PLACEHOLDER_HOST_NAME })).unwrap();
        assert_eq!(current().name, own.unwrap_or_else(|| UNNAMED_HOST.into()), "the placeholder is nobody's choice");
        crate::store::write_json(&crate::store::root().unwrap().join("account.json"), &serde_json::json!({ "userId": "u1", "hostDisplayName": " Studio " })).unwrap();
        assert_eq!(current().name, "Studio");
        let mut settings = crate::store::settings::load();
        settings.machine_name = Some("Desk Mac".into());
        crate::store::settings::save(&settings).unwrap();
        assert_eq!(current(), MachineName { name: "Desk Mac".into(), chosen: true, computer_name: recent_computer_name() });
    }
}
