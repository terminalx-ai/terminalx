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
        let spec = catalog::find(id).ok_or_else(|| anyhow!("unknown model {id}"))?;
        if is_installed(spec) {
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
                let outcome = fetch(spec, &cancel, &report);
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

/// Stream the weights to disk, reporting bytes received to `report` a few
/// times a second. Pure apart from the file system, so a test can drive it.
pub fn fetch(spec: &ModelSpec, cancel: &AtomicBool, report: &dyn Fn(u64)) -> Result<()> {
    let final_path = model_path(spec)?;
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = final_path.with_extension("gguf.part");
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(20)).build();
    let resp = agent.get(&spec.url()).call().map_err(|e| anyhow!("download failed: {e}"))?;
    let mut reader = resp.into_reader();
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
    std::fs::rename(&part, &final_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pulls the smallest model for real and runs a tone through it. Network
    /// and a couple of hundred megabytes, so opt in with `--ignored`.
    #[test]
    #[ignore]
    fn downloads_verifies_and_loads_the_smallest_model() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("RACCOON_HOME", home.path());
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
        let text = engine.transcribe(spec.id, &model_path(spec).unwrap(), &tone).expect("transcribe");
        eprintln!("tone transcribed as: {text:?}");
    }
}
