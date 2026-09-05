//! Screenshot export. The helper returns PNG bytes inline as base64; an agent
//! reading `--json` output would otherwise pull a megabyte of base64 into its
//! context. The app writes the image to a private temp directory and answers
//! with `screenshot.path`, keeping the inline data only when the file cannot
//! be written. Files older than a day are swept at most once an hour.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde_json::Value;

pub const SCREENSHOT_TMPDIR_ENV: &str = "TERMINALX_COMPUTER_SCREENSHOT_TMPDIR";
const SCREENSHOT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);
const CLEANUP_MARKER: &str = ".last-cleanup";

/// Replace inline screenshot data with a file path when possible.
pub fn export_to_file(result: &mut Value, request_id: &str) {
    let Some(data) = result
        .get("screenshot")
        .and_then(|s| s.get("data"))
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .map(str::to_owned)
    else {
        return;
    };
    let format = result
        .get("screenshot")
        .and_then(|s| s.get("format"))
        .and_then(Value::as_str)
        .unwrap_or("png")
        .to_owned();
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()) else {
        return;
    };
    let Ok(dir) = screenshot_dir() else {
        return;
    };
    cleanup(&dir);
    let extension = if format == "png" { "png" } else { "img" };
    let path = dir.join(format!("{}-screenshot.{extension}", safe_stem(request_id)));
    if write_private(&path, &bytes).is_err() {
        return;
    }
    let Some(screenshot) = result.get_mut("screenshot").and_then(Value::as_object_mut) else {
        return;
    };
    screenshot.remove("data");
    screenshot.insert("path".into(), Value::String(path.to_string_lossy().into_owned()));
    screenshot.insert("dataOmitted".into(), Value::Bool(true));
    let expires = chrono::Utc::now() + chrono::Duration::from_std(SCREENSHOT_TTL).unwrap_or_default();
    screenshot.insert(
        "expiresAt".into(),
        Value::String(expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
}

fn screenshot_dir() -> std::io::Result<PathBuf> {
    let dir = std::env::var_os(SCREENSHOT_TMPDIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("terminalx-computer-use"));
    create_private_dir(&dir)?;
    Ok(dir)
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    if !dir.exists() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    let metadata = std::fs::symlink_metadata(dir)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("unsafe screenshot temp path"));
    }
    if metadata.uid() != unsafe { libc::getuid() } {
        return Err(std::io::Error::other(
            "screenshot temp path is not owned by the current user",
        ));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// Agents call computer-use in loops; a marker file keeps cleanup from
/// becoming a directory scan per screenshot.
fn cleanup(dir: &Path) {
    let now = SystemTime::now();
    let marker = dir.join(CLEANUP_MARKER);
    if let Ok(modified) = std::fs::metadata(&marker).and_then(|m| m.modified()) {
        if now.duration_since(modified).unwrap_or_default() < CLEANUP_INTERVAL {
            return;
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with("-screenshot.png") && !name.ends_with("-screenshot.img") {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|modified| now.duration_since(modified).unwrap_or_default() > SCREENSHOT_TTL)
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let _ = write_private(&marker, b"cleaned\n");
}

fn safe_stem(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inline_data_becomes_a_private_file_with_metadata() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(SCREENSHOT_TMPDIR_ENV, dir.path());
        let png = b"\x89PNG\r\n\x1a\nfake";
        let encoded = base64::engine::general_purpose::STANDARD.encode(png);
        let mut result = json!({
            "snapshot": {"treeText": ""},
            "screenshot": {"data": encoded, "format": "png", "width": 10, "height": 5, "scale": 0.5},
            "screenshotStatus": {"state": "captured"}
        });
        export_to_file(&mut result, "req/1:x");
        std::env::remove_var(SCREENSHOT_TMPDIR_ENV);
        let screenshot = &result["screenshot"];
        assert!(screenshot.get("data").is_none());
        assert_eq!(screenshot["dataOmitted"], true);
        assert_eq!(screenshot["scale"], 0.5);
        let path = PathBuf::from(screenshot["path"].as_str().unwrap());
        assert_eq!(path.file_name().unwrap(), "req_1_x-screenshot.png");
        assert_eq!(std::fs::read(&path).unwrap(), png);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert!(screenshot["expiresAt"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn results_without_a_screenshot_are_untouched() {
        let mut skipped = json!({"screenshot": null, "screenshotStatus": {"state": "skipped"}});
        let before = skipped.clone();
        export_to_file(&mut skipped, "id");
        assert_eq!(skipped, before);

        let mut garbage = json!({"screenshot": {"data": "not base64!!", "format": "png"}});
        export_to_file(&mut garbage, "id");
        assert_eq!(garbage["screenshot"]["data"], "not base64!!");
    }
}
