//! Diagnostic public-API probe. Explicit checksum-pinned 16 kHz f32le files only.
//! No microphone, store, network inference, private native layout or application UI.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, io::Write, path::PathBuf, time::Instant};
use tx439_detector_adapter::Detector;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    model_path: PathBuf,
    model_sha256: String,
    inputs: Vec<Input>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    id: String,
    audio_path: PathBuf,
    sha256: String,
    sample_rate: u32,
}
fn verified(path: &PathBuf, sha: &str, limit: u64) -> Result<Vec<u8>> {
    if fs::metadata(path)?.len() > limit {
        return Err(format!("oversized input: {}", path.display()).into());
    }
    let data = fs::read(path)?;
    if format!("{:x}", Sha256::digest(&data)) != sha {
        return Err(format!("checksum mismatch: {}", path.display()).into());
    }
    Ok(data)
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        return Err("usage: tx439-detector-adapter MANIFEST_JSON NEW_OUTPUT_JSONL".into());
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args[1])?)?;
    if manifest.inputs.is_empty() {
        return Err("empty input manifest".into());
    }
    let model_bytes = verified(
        &manifest.model_path,
        &manifest.model_sha256,
        8 * 1024 * 1024,
    )?;
    let mut ids = std::collections::HashSet::new();
    // Validate every input before loading/running. A WAV header is not PCM.
    let mut inputs = Vec::new();
    for input in &manifest.inputs {
        if input.sample_rate != 16_000 || !ids.insert(&input.id) {
            return Err("require 16 kHz and unique input IDs".into());
        }
        let bytes = verified(&input.audio_path, &input.sha256, 16_000 * 4 * 300)?;
        if bytes.is_empty() || bytes.len() % 4 != 0 || bytes.starts_with(b"RIFF") {
            return Err("expected nonempty headerless f32le PCM".into());
        }
        let samples: Vec<_> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        if samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0) {
            return Err("PCM must be finite and in [-1, 1]".into());
        }
        inputs.push(samples);
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[2])?;
    let mut session = Detector::from_verified_bytes(&model_bytes)?;
    for (input, samples) in manifest.inputs.iter().zip(inputs) {
        for normalized in [false, true] {
            let peak = samples.iter().fold(0.0_f32, |a, s| a.max(s.abs()));
            let detector: Vec<_> = samples
                .iter()
                .map(|s| {
                    if normalized && peak > 0.0 {
                        *s / peak
                    } else {
                        *s
                    }
                })
                .collect();
            let detector_bytes: Vec<_> = detector.iter().flat_map(|s| s.to_le_bytes()).collect();
            let start = Instant::now();
            let result = session.probabilities(&detector, false);
            let elapsed_us = start.elapsed().as_micros();
            // Record failure rather than letting a failed call count as silence.
            let row = match result {
                Ok(result) => {
                    if result.len() != detector.len().div_ceil(512)
                        || result
                            .iter()
                            .any(|p| !p.is_finite() || !(0.0..=1.0).contains(p))
                    {
                        return Err("incomplete or invalid probability result".into());
                    }
                    serde_json::json!({"id":input.id, "normalized":normalized,
                        "inputSha256":input.sha256, "detectorSha256":format!("{:x}",Sha256::digest(&detector_bytes)),
                        "elapsedUs":elapsed_us, "probabilities":result,
                        "speech":result.iter().any(|p| *p >= 0.5), "error":null})
                }
                Err(error) => serde_json::json!({"id":input.id,"normalized":normalized,
                    "elapsedUs":elapsed_us,"error":error.to_string()}),
            };
            serde_json::to_writer(&mut output, &row)?;
            writeln!(output)?;
            output.flush()?;
            if row["error"].is_string() {
                return Err("native detector run failed; partial evidence retained".into());
            }
        }
    }
    Ok(())
}
