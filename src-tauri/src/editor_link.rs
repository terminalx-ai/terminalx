//! Opening a cloud workspace's checkout in an editor over SSH (PRO-215,
//! designs 14.06 and 14.16).
//!
//! The link is built here from a workspace id and an absolute path, never
//! taken from the web view: the host is always `<workspaceId>.terminalx`, the
//! alias the app's SSH config Include defines, so no script can point an
//! editor at another host, user or port. The opener's URL scope allows none
//! of these schemes.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshEditor {
    Vscode,
    Cursor,
    Zed,
}

impl SshEditor {
    fn label(self) -> &'static str {
        match self {
            SshEditor::Vscode => "VS Code",
            SshEditor::Cursor => "Cursor",
            SshEditor::Zed => "Zed",
        }
    }

    fn scheme(self) -> &'static str {
        match self {
            SshEditor::Vscode => "vscode",
            SshEditor::Cursor => "cursor",
            SshEditor::Zed => "zed",
        }
    }
}

/// Letters, digits, `-` and `_`, starting with a letter or digit: a leading
/// `-` could be read by ssh as an option.
fn valid_workspace_id(id: &str) -> bool {
    id.len() <= 128
        && id.bytes().next().is_some_and(|byte| byte.is_ascii_alphanumeric())
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Every byte outside RFC 3986's unreserved set is escaped, so `#`, `?`, `%`,
/// `@`, `:` and spaces in a folder name stay part of the path.
fn encode_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// The editor's link to `path` on the workspace, through its SSH alias only.
pub fn editor_url(editor: SshEditor, workspace_id: &str, path: &str) -> Result<String, String> {
    if !valid_workspace_id(workspace_id) {
        return Err("Invalid workspace".into());
    }
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    if !path.starts_with('/')
        || path.len() > 4096
        || path.chars().any(char::is_control)
        || segments.iter().any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err("Invalid checkout path".into());
    }
    let encoded: String = segments.iter().map(|segment| format!("/{}", encode_segment(segment))).collect();
    let alias = format!("{workspace_id}.terminalx");
    Ok(match editor {
        SshEditor::Zed => format!("zed://ssh/{alias}{encoded}"),
        SshEditor::Vscode | SshEditor::Cursor => format!("{}://vscode-remote/ssh-remote+{alias}{encoded}", editor.scheme()),
    })
}

/// Whether some application handles the editor's links on this computer.
enum Handler {
    Installed,
    Missing,
    /// Could not be asked; the reason is told only if opening then fails.
    Unknown(Option<&'static str>),
}

#[cfg(target_os = "macos")]
fn handler(editor: SshEditor) -> Handler {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let Some(probe) = NSURL::URLWithString(&NSString::from_str(&format!("{}://", editor.scheme()))) else {
        return Handler::Unknown(None);
    };
    if NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&probe).is_some() { Handler::Installed } else { Handler::Missing }
}

#[cfg(target_os = "linux")]
fn handler(editor: SshEditor) -> Handler {
    let output = std::process::Command::new("xdg-mime").args(["query", "default", &format!("x-scheme-handler/{}", editor.scheme())]).output();
    match output {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Handler::Unknown(Some("xdg-mime is not installed, so the app could not check which editors are")),
        Err(_) => Handler::Unknown(None),
        Ok(output) if !output.status.success() => Handler::Unknown(None),
        Ok(output) if String::from_utf8_lossy(&output.stdout).trim().is_empty() => Handler::Missing,
        Ok(_) => Handler::Installed,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn handler(_editor: SshEditor) -> Handler {
    Handler::Unknown(None)
}

#[tauri::command]
pub async fn cloud_open_in_editor(editor: SshEditor, workspace_id: String, path: String) -> Result<(), String> {
    let url = editor_url(editor, &workspace_id, &path)?;
    // Asking the system may start a process (xdg-mime): never on the async runtime's threads.
    let found = tauri::async_runtime::spawn_blocking(move || handler(editor)).await.unwrap_or(Handler::Unknown(None));
    let unknown = match found {
        Handler::Missing => return Err(format!("{} is not installed", editor.label())),
        Handler::Installed => None,
        Handler::Unknown(reason) => reason,
    };
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|error| match unknown {
        Some(reason) => format!("{} did not open: {reason}", editor.label()),
        None => format!("{} did not open: {error}", editor.label()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_go_through_the_workspace_alias_only() {
        let path = "/var/lib/terminalx/workspace/widgets";
        assert_eq!(editor_url(SshEditor::Vscode, "ws_1", path).unwrap(), "vscode://vscode-remote/ssh-remote+ws_1.terminalx/var/lib/terminalx/workspace/widgets");
        assert_eq!(editor_url(SshEditor::Cursor, "ws_1", path).unwrap(), "cursor://vscode-remote/ssh-remote+ws_1.terminalx/var/lib/terminalx/workspace/widgets");
        assert_eq!(editor_url(SshEditor::Zed, "ws_1", path).unwrap(), "zed://ssh/ws_1.terminalx/var/lib/terminalx/workspace/widgets");
        for id in ["", "-oProxyCommand=x", "_ws", "evil.example.com", "user@host", "host:22", "a/b", "ws 1", "ws%40x"] {
            assert!(editor_url(SshEditor::Zed, id, path).is_err(), "{id} accepted");
        }
    }

    #[test]
    fn a_path_keeps_its_special_characters_inside_the_path() {
        let url = editor_url(SshEditor::Vscode, "ws", "/w/a b#c?d%e@f:g").unwrap();
        assert_eq!(url, "vscode://vscode-remote/ssh-remote+ws.terminalx/w/a%20b%23c%3Fd%25e%40f%3Ag");
        for path in ["relative", "/w/../etc", "/w/./x", "/w//x", "/w/", "/w/a\nb", ""] {
            assert!(editor_url(SshEditor::Zed, "ws", path).is_err(), "{path:?} accepted");
        }
    }
}
