//! Opt-in real-model evaluation. No recordings, downloads, or user-store reads.
//! See the ignored test for the explicit fixture manifest contract.
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    /// Catalog ID; the weight path is explicit, never resolved from user state.
    model: String,
    model_path: std::path::PathBuf,
    /// Little-endian f32, mono, 16000 Hz, at most 60 seconds.
    audio_path: std::path::PathBuf,
    personalization_path: std::path::PathBuf,
    output_path: std::path::PathBuf,
    #[serde(default)]
    terms: Vec<String>,
    #[serde(default)]
    project: Option<String>,
    reference: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Score {
    word_error_rate: f64,
    term_accuracy: Option<f64>,
}
fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|s| {
            s.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|s| !s.is_empty())
        .collect()
}
fn score(reference: &str, hypothesis: &str, terms: &[String]) -> Score {
    let expected = words(reference);
    let actual = words(hypothesis);
    let mut row: Vec<usize> = (0..=actual.len()).collect();
    for (i, token) in expected.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, observed) in actual.iter().enumerate() {
            let previous = row[j + 1];
            row[j + 1] = (row[j] + 1)
                .min(previous + 1)
                .min(diagonal + usize::from(token != observed));
            diagonal = previous;
        }
    }
    let contains = |haystack: &str, needle: &str| {
        !needle.is_empty()
            && haystack.match_indices(needle).any(|(index, matched)| {
                let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '_');
                boundary(haystack[..index].chars().next_back())
                    && boundary(haystack[index + matched.len()..].chars().next())
            })
    };
    let relevant: Vec<_> = terms.iter().filter(|t| contains(reference, t)).collect();
    Score {
        // Empty reference: 0 for silence, otherwise insertion count. This
        // avoids disguising hallucination as a denominator-zero NaN.
        word_error_rate: row[actual.len()] as f64 / expected.len().max(1) as f64,
        term_accuracy: (!relevant.is_empty()).then(|| {
            relevant.iter().filter(|t| contains(hypothesis, t)).count() as f64
                / relevant.len() as f64
        }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    raw: String,
    final_text: String,
    score: Score,
    inference_ms: u128,
    processing_us: u128,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    model: String,
    audio_seconds: f64,
    reference: String,
    bias_terms: Vec<String>,
    candidate_terms: Vec<String>,
    /// Baseline includes first model load; paired timings are not equivalent.
    timing_note: &'static str,
    baseline: Outcome,
    personalized: Outcome,
}

/// Run only with a user-provided, explicit manifest:
/// TX_DICTATION_EVAL_MANIFEST=/private/manifest.json cargo test
/// transcription::evaluation::real_model_pair -- --ignored --exact
/// Manifest keys: model, modelPath, audioPath, personalizationPath, outputPath,
/// terms (optional), reference. Output must not already exist. No data is logged.
#[test]
#[ignore = "requires explicitly provided audio, model weights and evaluation manifest"]
#[cfg(target_os = "macos")]
fn real_model_pair() -> anyhow::Result<()> {
    use super::{context::RunContext, engine::Engine, personalization};
    use std::{io::Write, os::unix::fs::OpenOptionsExt, time::Instant};
    let manifest_path = std::env::var("TX_DICTATION_EVAL_MANIFEST")?;
    let manifest_bytes = std::fs::read(manifest_path)?;
    anyhow::ensure!(manifest_bytes.len() <= 65536, "Manifest exceeds 64 KB");
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    anyhow::ensure!(
        super::catalog::find(&manifest.model).is_some(),
        "Unknown catalog model"
    );
    anyhow::ensure!(
        manifest.reference.len() <= 8192 && manifest.terms.len() <= 64,
        "Reference/term list exceeds limits"
    );
    anyhow::ensure!(
        !personalization::is_sensitive(&manifest.reference)
            && manifest
                .terms
                .iter()
                .all(|t| t.len() <= 120 && !personalization::is_sensitive(t)),
        "Secret-like evaluation text rejected"
    );
    let length = std::fs::metadata(&manifest.audio_path)?.len();
    anyhow::ensure!(
        length > 0 && length <= 16000 * 60 * 4 && length.is_multiple_of(4),
        "Audio must be nonempty f32le mono 16kHz PCM, at most 60 seconds"
    );
    let samples: Vec<f32> = std::fs::read(&manifest.audio_path)?
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect();
    anyhow::ensure!(
        samples.iter().all(|s| s.is_finite() && s.abs() <= 1.0),
        "Audio samples must be finite and normalized"
    );
    anyhow::ensure!(
        std::fs::metadata(&manifest.personalization_path)?.len() <= 5_000_000,
        "Personalization file too large"
    );
    let data: personalization::Personalization =
        serde_json::from_slice(&std::fs::read(&manifest.personalization_path)?)?;
    personalization::validate(&data)?;
    let bias = personalization::compile(&data, manifest.project.as_deref(), &manifest.terms);
    let actual_bias = if manifest.model.starts_with("whisper-") {
        bias.clone()
    } else {
        Vec::new()
    };
    let personalized = RunContext {
        data,
        project: manifest.project.clone(),
        bias: actual_bias.clone(),
        ..Default::default()
    };
    let engine = Engine::default();
    // Create the destination before expensive inference, with no overwrite and
    // owner-only permissions. A failed evaluation leaves an empty private file.
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&manifest.output_path)?;
    let run = |context: &RunContext| -> anyhow::Result<Outcome> {
        let started = Instant::now();
        let raw = engine.transcribe(&manifest.model, &manifest.model_path, &samples, context)?;
        let inference_ms = started.elapsed().as_millis();
        let processing = Instant::now();
        let final_text = personalization::process(
            &raw,
            &context.data,
            context.project.as_deref(),
            &context.bias,
        );
        let processing_us = processing.elapsed().as_micros();
        let score = score(&manifest.reference, &final_text, &manifest.terms);
        Ok(Outcome {
            raw,
            final_text,
            score,
            inference_ms,
            processing_us,
        })
    };
    let baseline = run(&RunContext::default())?;
    let personalized = run(&personalized)?;
    let report = Report { model: manifest.model, audio_seconds: samples.len() as f64 / 16000.0, reference: manifest.reference, bias_terms: actual_bias, candidate_terms: bias, timing_note: "Baseline includes cold model load; personalized reuses weights. Direct-engine silence is evaluated without microphone capture guards. One paired recording is not an aggregate accuracy result.", baseline, personalized };
    output.write_all(&serde_json::to_vec_pretty(&report)?)?;
    output.sync_all()?;
    Ok(())
}

#[test]
fn scorer_counts_substitution_insertion_deletion_and_silence() {
    assert_eq!(
        score("open the file", "open a file", &[]).word_error_rate,
        1.0 / 3.0
    );
    assert_eq!(
        score("open file", "open the file", &[]).word_error_rate,
        0.5
    );
    assert_eq!(
        score("open the file", "open file", &[]).word_error_rate,
        1.0 / 3.0
    );
    assert_eq!(score("", "", &[]).word_error_rate, 0.0);
    assert_eq!(score("", "thank you", &[]).word_error_rate, 2.0);
    assert_eq!(
        score(
            "open Parakeet",
            "open parakeet",
            &["Parakeet".into(), "absent".into()]
        )
        .term_accuracy,
        Some(0.0)
    );
    assert_eq!(
        score("open Parakeet", "open Parakeet!", &["Parakeet".into()]).term_accuracy,
        Some(1.0)
    );
    assert_eq!(
        score("open Parakeet", "open ParakeetExtra", &["Parakeet".into()]).term_accuracy,
        Some(0.0)
    );
    assert_eq!(
        score("open Parakeet", "open para", &["Parakeet".into()]).term_accuracy,
        Some(0.0)
    );
}
