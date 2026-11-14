//! Fetching model weights. A download streams into a `.part` file beside its
//! final name and is renamed only once the size and checksum agree, so a file
//! at the final path is complete whatever happened to the process writing it.
//! Progress goes out as events a few times a second, not per chunk.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::catalog::{self, ModelSpec};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub received: u64,
    pub total: u64,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn models_dir() -> Result<PathBuf> {
    let dir = crate::store::root()?.join("models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn model_path(spec: &ModelSpec) -> Result<PathBuf> {
    Ok(models_dir()?.join(spec.id).join(spec.filename))
}

/// Complete on disk: right size, and the checksum was verified when it landed.
pub fn is_installed(spec: &ModelSpec) -> bool {
    model_path(spec).ok().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len() == spec.size_bytes).unwrap_or(false)
}

pub fn delete(spec: &ModelSpec) -> Result<()> {
    let dir = models_dir()?.join(spec.id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// One download at a time per model; a second click while one runs is a no-op.
#[derive(Default)]
pub struct Downloads {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
    progress: Mutex<HashMap<String, DownloadProgress>>,
}

impl Downloads {
    pub fn snapshot(&self, id: &str) -> Option<DownloadProgress> {
        self.progress.lock().unwrap().get(id).cloned()
    }

    pub fn start(self: &Arc<Self>, app: AppHandle, id: &str) -> Result<()> {
        let spec = catalog::downloadable(id).ok_or_else(|| anyhow!("unknown model {id}"))?;
        if spec.id != catalog::DETECTOR.id && is_installed(spec) {
            return Ok(());
        }
        let cancel = {
            let mut active = self.active.lock().unwrap();
            if active.contains_key(id) {
                return Ok(());
            }
            let flag = Arc::new(AtomicBool::new(false));
            active.insert(id.to_string(), flag.clone());
            flag
        };
        let me = self.clone();
        let id_owned = id.to_string();
        std::thread::Builder::new()
            .name(format!("download-{id}"))
            .spawn(move || {
                let report = |received: u64| {
                    let p = DownloadProgress { id: spec.id.into(), received, total: spec.size_bytes, done: false, error: None };
                    me.progress.lock().unwrap().insert(spec.id.into(), p.clone());
                    let _ = app.emit("transcription_download", p);
                };
                // Detector verification belongs on this worker, never the command/UI thread.
                // Invalid files are replaced only after an explicit download request
                // and successful pinned download; cancellation leaves the old file alone.
                let outcome = if spec.id == catalog::DETECTOR.id {
                    detector_download_needed(super::detector_file::inspect(), &cancel)
                        .and_then(|needed| if needed { fetch(spec, &cancel, &report) } else { Ok(()) })
                } else {
                    fetch(spec, &cancel, &report)
                };
                me.active.lock().unwrap().remove(&id_owned);
                let (done, error) = match outcome {
                    Ok(()) => (true, None),
                    Err(e) => (false, Some(format!("{e:#}"))),
                };
                let received = if done { spec.size_bytes } else { 0 };
                let p = DownloadProgress { id: id_owned.clone(), received, total: spec.size_bytes, done, error };
                me.progress.lock().unwrap().insert(id_owned, p.clone());
                let _ = app.emit("transcription_download", p);
            })
            .context("download thread")?;
        Ok(())
    }

    pub fn cancel(&self, id: &str) {
        if let Some(flag) = self.active.lock().unwrap().get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.active.lock().unwrap().contains_key(id)
    }
}

fn detector_download_needed(readiness: super::detector_file::Readiness, cancel: &AtomicBool) -> Result<bool> {
    use super::detector_file::Readiness;
    if cancel.load(Ordering::SeqCst) { bail!("download cancelled"); }
    match readiness {
        Readiness::VerifiedFile => Ok(false),
        Readiness::Missing | Readiness::Invalid => Ok(true),
        Readiness::Error => bail!("Could not verify the speech detector file. Check file access and retry."),
    }
}

/// Stream the weights to disk, reporting bytes received to `report` a few
/// times a second. Pure apart from the file system, so a test can drive it.
pub fn fetch(spec: &ModelSpec, cancel: &AtomicBool, report: &dyn Fn(u64)) -> Result<()> {
    let final_path = model_path(spec)?;
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if cancel.load(Ordering::SeqCst) { bail!("download cancelled"); }
    let agent = crate::data_privacy::http_agent().timeout_connect(Duration::from_secs(20)).timeout_read(Duration::from_secs(30)).build();
    let resp = agent.get(&spec.url()).call().map_err(|e| anyhow!("download failed: {e}"))?;
    receive(spec, resp.into_reader(), cancel, report, &final_path)
}

fn receive(spec: &ModelSpec, reader: impl Read, cancel: &AtomicBool,
    report: &dyn Fn(u64), final_path: &std::path::Path) -> Result<()> {
    if spec.id == catalog::DETECTOR.id {
        receive_detector(spec, reader, cancel, report, final_path)
    } else {
        receive_recognizer(spec, reader, cancel, report, final_path)
    }
}

/// Recovery owns an exclusively created, randomly named regular file in the
/// destination directory. Never open the legacy predictable .part entry.
/// NamedTempFile removes only its owned staging path on every error/cancel exit.
fn receive_detector(spec: &ModelSpec, mut reader: impl Read, cancel: &AtomicBool,
    report: &dyn Fn(u64), final_path: &std::path::Path) -> Result<()> {
    if cancel.load(Ordering::SeqCst) { bail!("download cancelled"); }
    let parent = final_path.parent().ok_or_else(|| anyhow!("missing detector directory"))?;
    let mut staging = tempfile::Builder::new().prefix(".detector-").suffix(".part").tempfile_in(parent)?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024];
    let mut last_report = Instant::now();
    report(0);
    loop {
        if cancel.load(Ordering::SeqCst) { bail!("download cancelled"); }
        let n = reader.read(&mut buf)?;
        if n == 0 { break; }
        if received.saturating_add(n as u64) > spec.size_bytes {
            bail!("download exceeded the pinned model size");
        }
        staging.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        received += n as u64;
        if last_report.elapsed() >= Duration::from_millis(200) {
            report(received);
            last_report = Instant::now();
        }
    }
    staging.flush()?;
    if received != spec.size_bytes {
        bail!("download was {received} bytes, expected {}", spec.size_bytes);
    }
    if format!("{:x}", hasher.finalize()) != spec.sha256 {
        bail!("checksum did not match; the file was discarded");
    }
    if cancel.load(Ordering::SeqCst) { bail!("download cancelled"); }
    // persist atomically replaces the final entry only after validation. On
    // failure PersistError still owns the temporary file and drops it here.
    staging.persist(final_path).map_err(|e| anyhow!("commit detector file: {}", e.error))?;
    Ok(())
}

// Preserve the existing recognizer staging behavior and policy separately.
fn receive_recognizer(spec: &ModelSpec, mut reader: impl Read, cancel: &AtomicBool,
    report: &dyn Fn(u64), final_path: &std::path::Path) -> Result<()> {
    let part = final_path.with_extension("gguf.part");
    let mut file = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024];
    let mut last_report = Instant::now();
    report(0);
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("download cancelled");
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if received.saturating_add(n as u64) > spec.size_bytes {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("download exceeded the pinned model size");
        }
        file.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        received += n as u64;
        if last_report.elapsed() >= Duration::from_millis(200) {
            report(received);
            last_report = Instant::now();
        }
    }
    file.flush()?;
    drop(file);
    if received != spec.size_bytes {
        let _ = std::fs::remove_file(&part);
        bail!("download was {received} bytes, expected {}", spec.size_bytes);
    }
    let digest = format!("{:x}", hasher.finalize());
    if digest != spec.sha256 {
        let _ = std::fs::remove_file(&part);
        bail!("checksum did not match; the file was discarded");
    }
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&part);
        bail!("download cancelled");
    }
    std::fs::rename(&part, final_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detector_recovery_replaces_invalid_files_but_not_verified_or_unreadable_files() {
        use super::super::detector_file::Readiness;
        let cancel = AtomicBool::new(false);
        assert!(detector_download_needed(Readiness::Invalid, &cancel).unwrap());
        assert!(detector_download_needed(Readiness::Missing, &cancel).unwrap());
        assert!(!detector_download_needed(Readiness::VerifiedFile, &cancel).unwrap());
        assert!(detector_download_needed(Readiness::Error, &cancel).is_err());
        cancel.store(true, Ordering::SeqCst);
        for status in [Readiness::Missing, Readiness::Invalid, Readiness::VerifiedFile, Readiness::Error] {
            assert!(detector_download_needed(status, &cancel).is_err());
        }
    }

    #[test]
    fn bounded_download_verifies_before_commit_and_honors_cancellation() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("model.gguf");
        let mut spec = catalog::DETECTOR.clone();
        spec.size_bytes = 3;
        spec.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let cancel = AtomicBool::new(false);
        for bytes in [b"abcd".as_slice(), b"ab".as_slice(), b"abd".as_slice()] {
            assert!(receive(&spec, bytes, &cancel, &|_| {}, &path).is_err());
            assert!(!path.exists());
            assert!(!path.with_extension("gguf.part").exists());
        }
        cancel.store(true, Ordering::SeqCst);
        assert!(receive(&spec, b"abc".as_slice(), &cancel, &|_| {}, &path).is_err());
        assert!(!path.exists());
        cancel.store(false, Ordering::SeqCst);
        receive(&spec, b"abc".as_slice(), &cancel, &|_| {}, &path).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"abc");
    }

    #[test]
    fn explicit_reinstall_commits_only_verified_bytes_and_cancel_preserves_old_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("detector.gguf");
        let mut spec = catalog::DETECTOR.clone();
        spec.size_bytes = 3;
        spec.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        std::fs::write(&path, b"bad").unwrap();
        let cancel = AtomicBool::new(false);
        assert!(receive(&spec, b"abd".as_slice(), &cancel, &|_| {}, &path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"bad");
        // Cancellation after opening the part file must preserve the old asset.
        assert!(receive(&spec, b"abc".as_slice(), &cancel, &|_| {
            cancel.store(true, Ordering::SeqCst);
        }, &path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"bad");
        cancel.store(false, Ordering::SeqCst);
        receive(&spec, b"abc".as_slice(), &cancel, &|_| {}, &path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
    }

    #[cfg(unix)]
    #[test]
    fn detector_owned_staging_preserves_preexisting_symlink_and_hardlink_aliases() {
        use std::os::unix::fs::{symlink, MetadataExt};
        struct BrokenReader;
        impl Read for BrokenReader {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("fixture read failure"))
            }
        }
        struct CancelAtEof<'a> {
            bytes: &'a [u8],
            cancel: &'a AtomicBool,
        }
        impl Read for CancelAtEof<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.bytes.read(buf)?;
                if n == 0 { self.cancel.store(true, Ordering::SeqCst); }
                Ok(n)
            }
        }
        for hard_link in [false, true] {
            for outcome in ["cancel", "late-cancel", "checksum", "short", "oversize", "io", "success"] {
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("detector.gguf");
                let alias = path.with_extension("gguf.part");
                std::fs::write(&path, b"bad").unwrap();
                if hard_link { std::fs::hard_link(&path, &alias).unwrap(); }
                else { symlink(&path, &alias).unwrap(); }
                let alias_inode = std::fs::symlink_metadata(&alias).unwrap().ino();
                let final_inode = std::fs::metadata(&path).unwrap().ino();
                let mut spec = catalog::DETECTOR.clone();
                spec.size_bytes = 3;
                spec.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
                let cancel = AtomicBool::new(false);
                let report = |_| {
                    // Only this operation's unique staging file has been added.
                    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 3);
                    assert_eq!(std::fs::read(&path).unwrap(), b"bad");
                    assert_eq!(std::fs::read(&alias).unwrap(), b"bad");
                    if outcome == "cancel" { cancel.store(true, Ordering::SeqCst); }
                };
                let result = match outcome {
                    "checksum" => receive(&spec, b"abd".as_slice(), &cancel, &report, &path),
                    "short" => receive(&spec, b"ab".as_slice(), &cancel, &report, &path),
                    "oversize" => receive(&spec, b"abcd".as_slice(), &cancel, &report, &path),
                    "io" => receive(&spec, b"a".as_slice().chain(BrokenReader), &cancel, &report, &path),
                    "late-cancel" => receive(&spec, CancelAtEof { bytes: b"abc", cancel: &cancel }, &cancel, &report, &path),
                    _ => receive(&spec, b"abc".as_slice(), &cancel, &report, &path),
                };
                assert_eq!(result.is_ok(), outcome == "success");
                assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2, "owned staging leaked");
                assert_eq!(std::fs::symlink_metadata(&alias).unwrap().ino(), alias_inode);
                if !hard_link { assert_eq!(std::fs::read_link(&alias).unwrap(), path); }
                if outcome == "success" {
                    assert_eq!(std::fs::read(&path).unwrap(), b"abc");
                    // A hard link still names the old inode; a symlink follows
                    // the intentionally replaced final entry after success.
                    assert_eq!(std::fs::read(&alias).unwrap(), if hard_link { b"bad" } else { b"abc" });
                } else {
                    assert_eq!(std::fs::metadata(&path).unwrap().ino(), final_inode);
                    assert_eq!(std::fs::read(&path).unwrap(), b"bad");
                    assert_eq!(std::fs::read(&alias).unwrap(), b"bad");
                }
            }
        }
    }

    #[test]
    fn detector_owned_staging_is_removed_on_commit_error() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("directory.gguf");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), b"original").unwrap();
        let mut spec = catalog::DETECTOR.clone();
        spec.size_bytes = 3;
        spec.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(receive(&spec, b"abc".as_slice(), &AtomicBool::new(false), &|_| {}, &path).is_err());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        assert_eq!(std::fs::read(path.join("keep")).unwrap(), b"original");
    }

    /// Pulls the smallest model for real and runs a tone through it. Network
    /// and a couple of hundred megabytes, so opt in with `--ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn downloads_verifies_and_loads_the_smallest_model() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("TERMINALX_HOME", home.path());
        let spec = catalog::find("canary-180m-flash").unwrap();
        let cancel = AtomicBool::new(false);
        let seen = Mutex::new(0u64);
        fetch(spec, &cancel, &|r| *seen.lock().unwrap() = r).expect("download");
        assert!(is_installed(spec));
        assert!(*seen.lock().unwrap() > 0);
        let engine = super::super::engine::Engine::default();
        // One second of a 440 Hz tone: the engine must load and answer, even
        // if the answer is empty.
        let tone: Vec<f32> = (0..16_000).map(|i| (i as f32 * 440.0 * 2.0 * std::f32::consts::PI / 16_000.0).sin() * 0.2).collect();
        let text = engine.transcribe(spec.id, &model_path(spec).unwrap(), &tone, &super::super::context::RunContext::default()).expect("transcribe");
        eprintln!("tone transcribed as: {text:?}");
    }
}
