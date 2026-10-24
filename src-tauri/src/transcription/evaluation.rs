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
    /// Prime this exact audio through the loaded engine before timing either arm.
    #[serde(default)]
    warmup: bool,
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
    raw_score: Score,
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
    context_compile_us: u128,
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
    let manifest_path = std::env::var("TX_DICTATION_EVAL_MANIFEST")?;
    let manifest_bytes = std::fs::read(manifest_path)?;
    anyhow::ensure!(manifest_bytes.len() <= 65536, "Manifest exceeds 64 KB");
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    evaluate(manifest, &super::engine::Engine::default())
}

/// Explicit batch input, retaining the same model between paired recordings.
/// Never downloads or discovers audio. Every row is attempted, including failures.
#[test]
#[ignore = "requires an explicit synthetic/public or donated audio matrix"]
#[cfg(target_os = "macos")]
fn real_model_matrix() -> anyhow::Result<()> {
    let bytes = std::fs::read(std::env::var("TX_DICTATION_EVAL_MANIFEST")?)?;
    anyhow::ensure!(bytes.len() <= 2_000_000, "Matrix exceeds 2 MB");
    let manifests: Vec<Manifest> = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(
        !manifests.is_empty() && manifests.len() <= 512,
        "Invalid matrix size"
    );
    let engine = super::engine::Engine::default();
    let mut failures = Vec::new();
    for (index, manifest) in manifests.into_iter().enumerate() {
        if let Err(error) = evaluate(manifest, &engine) {
            failures.push(format!("row {index}: {error:#}"));
        }
    }
    anyhow::ensure!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}

/// Learn from explicitly supplied real recognizer output, never from user history.
#[test]
#[ignore = "requires observed recognizer output and an explicit report path"]
fn observed_corrections() -> anyhow::Result<()> {
    use super::personalization::{self, Options, Personalization};
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Observation {
        before: String,
        after: String,
        output_path: std::path::PathBuf,
    }
    let bytes = std::fs::read(std::env::var("TX_DICTATION_EVAL_MANIFEST")?)?;
    anyhow::ensure!(bytes.len() <= 65536, "Observations exceed 64 KB");
    let observations: Vec<Observation> = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(observations.len() <= 64, "Too many observations");
    for observation in observations {
        let _home = crate::store::temp_home();
        personalization::save_revision(&Personalization {
            options: Options {
                learn: true,
                ..Default::default()
            },
            ..Default::default()
        })?;
        let accepted = personalization::learn(&observation.before, &observation.after, None)?;
        let duplicate = personalization::learn(&observation.before, &observation.after, None)?;
        anyhow::ensure!(!duplicate, "Repeated correction must not be learned twice");
        let data = personalization::load()?;
        anyhow::ensure!(
            data.entries.len() == usize::from(accepted),
            "Unexpected learned count"
        );
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(observation.output_path)?;
        serde_json::to_writer_pretty(&mut file, &data)?;
    }
    Ok(())
}

/// Measure real project walking/compiler gates using only a disposable project.
#[test]
#[ignore = "writes an explicit context measurement report"]
fn context_measurement() -> anyhow::Result<()> {
    use super::{
        context::{self, ContextRequest, RunContext},
        personalization::{self, Options, Personalization},
    };
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir()?;
    std::fs::write(project.path().join(".gitignore"), "ignored/\n")?;
    std::fs::create_dir(project.path().join("ignored"))?;
    std::fs::write(
        project.path().join("ignored/SecretIdentifier.ts"),
        "never read this content",
    )?;
    for i in 0..100 {
        std::fs::write(project.path().join(format!("FixtureSymbol{i}.ts")), "")?;
    }
    personalization::save_revision(&Personalization {
        options: Options {
            context: true,
            project: true,
            composer: true,
            terminal: true,
            ..Default::default()
        },
        ..Default::default()
    })?;
    let started = std::time::Instant::now();
    let terms = context::project_terms(project.path());
    let walk_us = started.elapsed().as_micros();
    anyhow::ensure!(
        !terms.iter().any(|s| s.contains("SecretIdentifier")),
        "Ignored path leaked"
    );
    let mut rows = Vec::new();
    for (name, remote, sensitive) in [
        ("local", false, false),
        ("remoteOff", true, false),
        ("sensitive", false, true),
    ] {
        let started = std::time::Instant::now();
        let run = RunContext::prepare(ContextRequest {
            project_terms: terms.clone(),
            remote,
            sensitive,
            composer: "UnlabelledPrivateWord".into(),
            ..Default::default()
        });
        let prepare_us = started.elapsed().as_micros();
        anyhow::ensure!(
            !run.bias.iter().any(|s| s.contains("PrivateWord")),
            "Untrusted draft leaked"
        );
        if remote || sensitive {
            anyhow::ensure!(run.bias.is_empty(), "Suppressed context leaked");
        }
        rows.push(serde_json::json!({"surface":name,"biasTerms":run.bias,"prepareUs":prepare_us}));
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(std::env::var("TX_CONTEXT_REPORT")?)?;
    serde_json::to_writer_pretty(
        file,
        &serde_json::json!({"projectWalkUs":walk_us,"fileCount":100,"rows":rows}),
    )?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn evaluate(manifest: Manifest, engine: &super::engine::Engine) -> anyhow::Result<()> {
    use super::{context::RunContext, personalization};
    use std::{io::Write, os::unix::fs::OpenOptionsExt, time::Instant};
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
    let context_started = Instant::now();
    let bias = personalization::compile(&data, manifest.project.as_deref(), &manifest.terms);
    let context_compile_us = context_started.elapsed().as_micros();
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
    // Create the destination before expensive inference, with no overwrite and
    // owner-only permissions. A failed evaluation leaves an empty private file.
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&manifest.output_path)?;
    if manifest.warmup {
        engine.transcribe(
            &manifest.model,
            &manifest.model_path,
            &samples,
            &RunContext::default(),
        )?;
    }
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
        let raw_score = self::score(&manifest.reference, &raw, &manifest.terms);
        Ok(Outcome {
            raw,
            final_text,
            score,
            raw_score,
            inference_ms,
            processing_us,
        })
    };
    let baseline = run(&RunContext::default())?;
    let personalized = run(&personalized)?;
    let timing_note = if manifest.warmup {
        "Both arms follow an untimed run on identical audio. Inference plus processing is a file stop-to-final proxy, not microphone latency. Direct-engine silence bypasses capture guards."
    } else {
        "Baseline may include cold model load; personalized reuses weights. Direct-engine silence bypasses capture guards. One pair is not an aggregate accuracy result."
    };
    let report = Report {
        model: manifest.model,
        audio_seconds: samples.len() as f64 / 16000.0,
        reference: manifest.reference,
        bias_terms: actual_bias,
        candidate_terms: bias,
        context_compile_us,
        timing_note,
        baseline,
        personalized,
    };
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
