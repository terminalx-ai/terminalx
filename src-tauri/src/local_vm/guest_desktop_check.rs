//! One explicit, guest-only native input/readback check. The check owns a fresh
//! document, never arbitrary app content. Driver refusals are not retried or
//! escalated; uncertain documents remain available for deliberate inspection.
use super::{finite, Paths};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(super) fn failure_reason(error: &anyhow::Error) -> &'static str {
    // Only our fixed stage labels may leave the guest; Driver output, screen
    // content, document paths and arbitrary OS errors are never persisted.
    match error.to_string().as_str() {
        "Guest check document could not be opened" => {
            "guest_native_desktop_document_open_unverified"
        }
        "Guest check document window unverified"
        | "Guest check document was not available; inspect it before trying another check" => {
            "guest_native_desktop_document_window_unverified"
        }
        "Guest initial document snapshot unverified" => {
            "guest_native_desktop_initial_snapshot_unverified"
        }
        "Guest check file cleanup failed" => "guest_native_desktop_cleanup_unverified",
        "Guest native input failed" => "guest_native_desktop_input_unverified",
        "Guest native readback failed" => "guest_native_desktop_readback_unverified",
        "Guest application save request failed" => {
            if error
                .chain()
                .any(|cause| cause.to_string() == "Guest native menu path unavailable")
            {
                "guest_native_desktop_save_menu_missing"
            } else if error
                .chain()
                .any(|cause| cause.to_string() == "Guest native menu item disabled")
            {
                "guest_native_desktop_save_menu_disabled"
            } else if error
                .chain()
                .any(|cause| cause.to_string() == "Guest native menu focus unverified")
            {
                "guest_native_desktop_save_menu_focus_unverified"
            } else if error
                .chain()
                .any(|cause| cause.to_string() == "Setup helper ended without confirmed outcome")
            {
                "guest_native_desktop_save_request_interrupted"
            } else if error
                .chain()
                .any(|cause| cause.to_string() == "Guest desktop response was invalid")
            {
                "guest_native_desktop_save_response_invalid"
            } else {
                "guest_native_desktop_save_request_unverified"
            }
        }
        "Guest application saved file could not be read" => {
            "guest_native_desktop_saved_file_unreadable"
        }
        "Guest application save was not verified; no shortcut was replayed" => {
            "guest_native_desktop_save_unverified"
        }
        "Guest check document close failed"
        | "Guest check document close was not verified; inspect the retained document" => {
            "guest_native_desktop_close_unverified"
        }
        _ => "guest_native_desktop_check_incomplete_inspect_document",
    }
}

fn call(tool: &str, arguments: Value, paths: &Paths, closed: &AtomicBool) -> Result<Value> {
    let encoded = serde_json::to_string(&arguments)?;
    let result = finite(
        &paths.driver,
        &["call", tool, &encoded],
        paths,
        closed,
        Duration::from_secs(20),
    )?;
    if tool == "invoke_menu" {
        // Map only fixed public Driver refusal categories. Never retain the
        // response text, arbitrary menu content, paths or process identifiers.
        for bytes in [&result.bytes, &result.err] {
            let text = String::from_utf8_lossy(bytes);
            if text.contains("invoke_menu: path segment") && text.contains("was not found") {
                bail!("Guest native menu path unavailable");
            }
            if text.contains("invoke_menu: path segment") && text.contains("is disabled") {
                bail!("Guest native menu item disabled");
            }
            if text.contains("did not become stably key and frontmost") {
                bail!("Guest native menu focus unverified");
            }
        }
    }
    if result.code != 0 {
        bail!("Guest desktop verification was refused; no input was replayed");
    }
    let value: Value =
        serde_json::from_slice(&result.bytes).context("Guest desktop response was invalid")?;
    if value["isError"] == true
        || value["ok"] == false
        || value["effect"] == "refused"
        || value["status"] == "refused"
    {
        bail!("Guest desktop verification was refused; inspect the guest");
    }
    Ok(value)
}

fn document_window(windows: &Value, name: &str) -> Result<Option<(i64, u64)>> {
    let stem = name.strip_suffix(".txt").context("Check document name")?;
    let candidates: Vec<_> = windows["windows"]
        .as_array()
        .context("Driver window inventory missing")?
        .iter()
        .filter(|w| {
            w["app_name"] == "TextEdit"
                && w["is_on_screen"] == true
                && matches!(w["title"].as_str(), Some(title) if title == name || title == stem)
        })
        .collect();
    if candidates.len() > 1 {
        bail!("Guest check document window is ambiguous");
    }
    candidates
        .first()
        .map(|w| {
            let pid = w["pid"]
                .as_i64()
                .filter(|p| *p > 0)
                .context("Check window PID missing")?;
            let window = w["window_id"]
                .as_u64()
                .filter(|w| *w > 0)
                .context("Check window identity missing")?;
            Ok((pid, window))
        })
        .transpose()
}

fn editor(snapshot: &Value, pid: i64, window: u64, expected: &str) -> Result<String> {
    if snapshot["pid"] != pid || snapshot["window_id"] != window || snapshot["degraded"] == true {
        bail!("Guest check document snapshot is unbound or degraded");
    }
    let editors: Vec<_> = snapshot["elements"]
        .as_array()
        .context("Native editor elements missing")?
        .iter()
        .filter(|e| e["role"] == "AXTextArea")
        .collect();
    // Driver 0.28.0 omits `value` for an empty native field. Permit that only
    // before typing into our freshly created empty document; positive readback
    // must still contain the exact nonempty nonce.
    let matches = editors.len() == 1
        && (editors[0]["value"].as_str() == Some(expected)
            || expected.is_empty() && editors[0].get("value").is_none());
    if !matches {
        bail!("Guest check document editor is ambiguous or has unexpected content");
    }
    editors[0]["element_token"]
        .as_str()
        .map(str::to_owned)
        .context("Native editor snapshot token missing")
}

pub(super) fn verify(paths: &Paths, closed: &AtomicBool) -> Result<()> {
    let directory = paths.home.join(".terminalx-local/setup-checks");
    super::super::super::journal::private_directory(&directory)?;
    let nonce = super::super::super::journal::new_id();
    let session = format!("terminalx-setup-{nonce}");
    let name = format!("terminalx-desktop-check-{nonce}.txt");
    let file = directory.join(&name);
    // create_new prevents replacing a retained or unrelated document. Opening a
    // real .txt document gives TextEdit a known save destination, with no dialog.
    let mut created = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)?;
    created.write_all(b"")?;
    created.sync_all()?;
    drop(created);
    let opened = finite(
        &paths.open,
        &[
            "-a",
            "/System/Applications/TextEdit.app",
            file.to_str().context("Check document path")?,
        ],
        paths,
        closed,
        Duration::from_secs(10),
    )
    .context("Guest check document could not be opened")?;
    if opened.code != 0 {
        bail!("Guest check document could not be opened");
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let (pid, window) = loop {
        if closed.load(Ordering::Acquire) || Instant::now() >= deadline {
            bail!("Guest check document was not available; inspect it before trying another check");
        }
        if let Some(target) = document_window(
            &call("list_windows", json!({}), paths, closed)
                .context("Guest check document window unverified")?,
            &name,
        )
        .context("Guest check document window unverified")?
        {
            break target;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let target = json!({"pid":pid,"window_id":window,"session":session});
    let snapshot = call("get_window_state", target.clone(), paths, closed)
        .context("Guest initial document snapshot unverified")?;
    let token =
        editor(&snapshot, pid, window, "").context("Guest initial document snapshot unverified")?;
    let marker = format!("TerminalX desktop check {nonce}");
    call(
        "type_text",
        json!({"pid":pid,"window_id":window,"session":session,"element_token":token,"text":marker}),
        paths,
        closed,
    )
    .context("Guest native input failed")?;
    // A generic action receipt is insufficient. Require a fresh exact-window
    // native readback, then a separate application save/file round trip.
    let snapshot = call("get_window_state", target.clone(), paths, closed)
        .context("Guest native readback failed")?;
    editor(&snapshot, pid, window, &marker).context("Guest native readback failed")?;
    // The pinned English TextEdit profile exposes this native menu path.
    // Driver resolves it live only after confirming this exact window is key.
    // A missing/disabled menu is a refusal, never a reason to replay a shortcut.
    call(
        "invoke_menu",
        json!({"pid":pid,"window_id":window,"session":session,"path":["File","Save…"]}),
        paths,
        closed,
    )
    .context("Guest application save request failed")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let bytes = super::super::read_bounded(&file, 4096)
            .context("Guest application saved file could not be read")?;
        if bytes == marker.as_bytes() {
            break;
        }
        if closed.load(Ordering::Acquire) || Instant::now() >= deadline {
            bail!("Guest application save was not verified; no shortcut was replayed");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Closing only the checked, saved document leaves other app windows alone.
    // A failed close is still an unresolved setup effect, never Ready.
    let snapshot = call("get_window_state", target, paths, closed)
        .context("Guest check document close failed")?;
    editor(&snapshot, pid, window, &marker).context("Guest check document close failed")?;
    call(
        "invoke_menu",
        json!({"pid":pid,"window_id":window,"session":session,"path":["File","Close"]}),
        paths,
        closed,
    )
    .context("Guest check document close failed")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let windows = call("list_windows", json!({"pid":pid}), paths, closed)
            .context("Guest check document close failed")?;
        let still_present = windows["windows"]
            .as_array()
            .context("Guest check document close failed")?
            .iter()
            .any(|w| w["window_id"] == window);
        if !still_present {
            break;
        }
        if closed.load(Ordering::Acquire) || Instant::now() >= deadline {
            bail!("Guest check document close was not verified; inspect the retained document");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    fs::remove_file(file).context("Guest check file cleanup failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_requires_the_unique_owned_document_and_exact_native_snapshot() {
        let name = "terminalx-desktop-check-test.txt";
        let own =
            json!({"app_name":"TextEdit","title":name,"is_on_screen":true,"pid":10,"window_id":20});
        assert_eq!(
            document_window(&json!({"windows":[own.clone()]}), name).unwrap(),
            Some((10, 20))
        );
        assert!(document_window(&json!({"windows":[own.clone(),own]}), name).is_err());
        assert_eq!(document_window(&json!({"windows":[{"app_name":"TextEdit","title":"unrelated.txt","is_on_screen":true,"pid":10,"window_id":20}]}), name).unwrap(), None);
        let mut snapshot = json!({"pid":10,"window_id":20,"elements":[{"role":"AXTextArea","value":"","element_token":"s1:1"}]});
        assert!(editor(&snapshot, 10, 21, "").is_err());
        assert!(editor(&snapshot, 10, 20, "nonce").is_err());
        assert_eq!(editor(&snapshot, 10, 20, "").unwrap(), "s1:1");
        snapshot["elements"][0]
            .as_object_mut()
            .unwrap()
            .remove("value");
        assert_eq!(editor(&snapshot, 10, 20, "").unwrap(), "s1:1");
        assert!(editor(&snapshot, 10, 20, "nonce").is_err());
        snapshot["degraded"] = json!(true);
        assert!(editor(&snapshot, 10, 20, "").is_err());
    }
}
