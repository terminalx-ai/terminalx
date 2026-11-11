//! Running audio through a local model. Loading takes seconds and hundreds of
//! megabytes, so the loaded model is kept between dictations and only let go
//! when the selection changes or the weights are deleted.
//!
//! A dictation holds its own handle to the model while it runs, so letting go
//! here never pulls the weights out from under one. `transcribe-cpp`
//! serialises compute per model: one-shot runs queue, and a stream holds the
//! model for its whole life, so anything that would overlap it is refused
//! with `Error::Busy` rather than raced.

#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use anyhow::{anyhow, Result};

#[cfg(any(target_os = "macos", test))]
pub const TARGET_RATE: u32 = 16_000;

#[cfg(target_os = "macos")]
struct Loaded {
    id: String,
    model: transcribe_cpp::Model,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
pub struct Engine {
    loaded: Mutex<Option<Loaded>>,
    pub noise: super::noise::NoiseGuard,
}

#[cfg(target_os = "macos")]
impl Engine {
    pub fn unload(&self) {
        *self.loaded.lock().unwrap() = None;
    }

    pub fn unload_if(&self, id: &str) {
        let mut guard = self.loaded.lock().unwrap();
        if guard.as_ref().map(|l| l.id == id).unwrap_or(false) {
            *guard = None;
        }
    }

    /// The model for `id`, loading `path` first if it is not the one already
    /// in hand. Blocking; call from a worker thread.
    fn model(&self, id: &str, path: &Path) -> Result<transcribe_cpp::Model> {
        let mut guard = self.loaded.lock().unwrap();
        if guard.as_ref().map(|l| l.id != id).unwrap_or(true) {
            let model = transcribe_cpp::Model::load(path).map_err(|e| anyhow!("could not load the model: {e}"))?;
            *guard = Some(Loaded { id: id.into(), model });
        }
        Ok(guard.as_ref().expect("just loaded").model.clone())
    }

    /// Transcribe 16 kHz mono audio, loading `path` first if it is not the
    /// model already in hand. Blocking; call from a worker thread.
    pub fn transcribe(&self, id: &str, path: &Path, audio: &[f32], context: &super::context::RunContext) -> Result<String> {
        // A quarter second cannot hold a word; loading a model for it would
        // cost seconds and answer with nothing or an invented one.
        if audio.len() < TARGET_RATE as usize / 4 {
            return Ok(String::new());
        }
        self.open(id, path, context)?.transcribe(audio)
    }

    /// Get `id` ready for one dictation: loaded, with a session of its own and
    /// the run options this dictation's context asks for. Blocking; call from
    /// a worker thread.
    pub fn open(&self, id: &str, path: &Path, context: &super::context::RunContext) -> Result<Local> {
        let options = run_options(id, context)?;
        let model = self.model(id, path)?;
        let session = model.session().map_err(|e| anyhow!("could not open a session: {e}"))?;
        Ok(Local { streams: model.capabilities().supports_streaming, session, options })
    }
}

/// One dictation's hold on a local model.
#[cfg(target_os = "macos")]
pub struct Local {
    session: transcribe_cpp::Session,
    options: transcribe_cpp::RunOptions,
    streams: bool,
}

#[cfg(target_os = "macos")]
impl Local {
    /// Whether the model says it can transcribe audio as it arrives. The
    /// weights answer this themselves, so a model added to the catalog gets
    /// live words, or does not, without anything here naming it.
    pub fn streams(&self) -> bool {
        self.streams
    }

    /// Begin streaming. The reason, if the model will not.
    pub fn stream(&mut self) -> std::result::Result<ModelStream<'_>, String> {
        let stream = self.session.stream(&self.options, &transcribe_cpp::StreamOptions::default()).map_err(|e| e.to_string())?;
        Ok(ModelStream(stream))
    }

    /// Transcribe a whole recording in one go.
    pub fn transcribe(&mut self, audio: &[f32]) -> Result<String> {
        let transcript = self.session.run(audio, &self.options).map_err(|e| anyhow!("transcription failed: {e}"))?;
        Ok(transcript.text.trim().to_string())
    }
}

/// A local model's stream, as dictation reads it.
#[cfg(target_os = "macos")]
pub struct ModelStream<'a>(transcribe_cpp::Stream<'a>);

#[cfg(target_os = "macos")]
impl super::live::LiveStream for ModelStream<'_> {
    /// The committed text (append-only, never rewritten) and the tentative
    /// tail after it, which the next feed may revise: the flicker-free
    /// display the library recommends.
    fn feed(&mut self, pcm: &[f32]) -> Result<String> {
        self.0.feed(pcm).map_err(|e| anyhow!("{e}"))?;
        Ok(self.0.text().display())
    }

    /// The model's whole final hypothesis. Finalize only appends to the
    /// committed text, and the full text is the library's authoritative
    /// transcript where the two could ever disagree.
    fn finalize(&mut self) -> Result<String> {
        self.0.finalize().map_err(|e| anyhow!("{e}"))?;
        Ok(self.0.text().full)
    }
}

#[cfg(target_os = "macos")]
fn run_options(id: &str, context: &super::context::RunContext) -> Result<transcribe_cpp::RunOptions> {
    let mut options = transcribe_cpp::RunOptions::default();
    // Parakeet and Nemotron expose no vocabulary bias extension. The
    // common deterministic repair still runs after every engine.
    if id.starts_with("whisper-") {
        options.language = context.data.options.language.clone();
        if !context.bias.is_empty() {
            options.family = Some(transcribe_cpp::RunExtension::Whisper(transcribe_cpp::WhisperRunOptions {
                initial_prompt: Some(context.bias.join(", ")),
                max_prev_context_tokens: Some(224),
                ..Default::default()
            }));
        }
    } else if id == "canary-180m-flash" {
        if context
            .data
            .options
            .language
            .as_deref()
            .is_some_and(|language| !matches!(language, "en" | "de" | "es" | "fr"))
        {
            return Err(anyhow!(
                "Canary supports English, German, Spanish and French. Choose one of these languages or Automatic in Settings → Transcription."
            ));
        }
        options.language = context.data.options.language.clone();
    }
    Ok(options)
}

// Dictation is already unavailable off macOS. Avoid linking an unused native
// model runtime there; selection/unload remain safe until dictation is ported.
#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct Engine {
    pub noise: super::noise::NoiseGuard,
}

#[cfg(not(target_os = "macos"))]
impl Engine {
    pub fn unload(&self) {}
    pub fn unload_if(&self, _id: &str) {}
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn all_off_keeps_runtime_defaults_for_every_catalog_model() {
        for model in super::super::catalog::MODELS {
            let options = run_options(model.id, &super::super::context::RunContext::default()).unwrap();
            assert!(options.family.is_none());
            assert!(options.language.is_none());
        }
    }

    #[test]
    fn only_supported_engines_receive_their_hints() {
        let mut context = super::super::context::RunContext {
            bias: vec!["DictationEngine".into()],
            ..Default::default()
        };
        context.data.options.language = Some("en".into());
        for model in ["whisper-small", "whisper-large-v3-turbo"] {
            let options = run_options(model, &context).unwrap();
            assert_eq!(options.language.as_deref(), Some("en"));
            let Some(transcribe_cpp::RunExtension::Whisper(hints)) = options.family else {
                panic!("missing Whisper hints")
            };
            assert_eq!(hints.initial_prompt.as_deref(), Some("DictationEngine"));
            assert_eq!(hints.max_prev_context_tokens, Some(224));
        }
        for model in ["parakeet-unified-en-0.6b", "nemotron-3.5-asr-streaming-0.6b"] {
            let options = run_options(model, &context).unwrap();
            assert!(options.family.is_none());
            assert!(options.language.is_none());
        }
        let options = run_options("canary-180m-flash", &context).unwrap();
        assert!(options.family.is_none());
        assert_eq!(options.language.as_deref(), Some("en"));
        context.data.options.language = Some("ja".into());
        assert!(run_options("canary-180m-flash", &context).is_err());
    }

    // ---- real weights, opt in (#754)
    //
    // TX_DICTATION_MODELS=<a directory laid out like the app's models
    // directory, `<id>/<file>`> cargo test --lib transcription::engine -- --ignored
    //
    // Never reads the user's own store, records or downloads anything: the
    // weights are named explicitly, and the speech is macOS's own `say`.

    use super::super::catalog::{ModelSpec, MODELS};
    use super::super::context::RunContext;
    use super::super::live::{self, Ending};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    fn installed() -> Vec<(&'static ModelSpec, PathBuf)> {
        let dir = PathBuf::from(std::env::var("TX_DICTATION_MODELS").expect("TX_DICTATION_MODELS names a models directory"));
        let present: Vec<_> = MODELS
            .iter()
            .filter_map(|spec| {
                let path = dir.join(spec.id).join(spec.filename);
                path.is_file().then_some((spec, path))
            })
            .collect();
        assert!(!present.is_empty(), "no catalog model in {}", dir.display());
        present
    }

    const SPOKEN: &str = "Please add a settings page for notifications. Then write the unit tests for it, and run them before you open the pull request.";

    /// `text`, spoken by macOS into 16 kHz mono float samples.
    fn spoken(text: &str) -> Vec<f32> {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("speech.wav");
        let status = std::process::Command::new("say")
            .args(["-o"]).arg(&wav)
            .args(["--file-format=WAVE", "--data-format=LEF32@16000", text])
            .status()
            .expect("macOS `say`");
        assert!(status.success());
        let bytes = std::fs::read(&wav).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        let mut at = 12;
        while at + 8 <= bytes.len() {
            let id = &bytes[at..at + 4];
            let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            let body = &bytes[at + 8..(at + 8 + len).min(bytes.len())];
            if id == b"fmt " {
                assert_eq!(u16::from_le_bytes([body[0], body[1]]), 3, "IEEE float");
                assert_eq!(u16::from_le_bytes([body[2], body[3]]), 1, "mono");
                assert_eq!(u32::from_le_bytes(body[4..8].try_into().unwrap()), TARGET_RATE);
            }
            if id == b"data" {
                return body.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
            }
            at += 8 + len + (len & 1);
        }
        panic!("no data chunk in the speech fixture");
    }

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace()
            .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
            .filter(|w| !w.is_empty())
            .collect()
    }

    /// Word error rate of `heard` against `said`.
    fn wer(said: &str, heard: &str) -> f64 {
        let (a, b) = (words(said), words(heard));
        let mut row: Vec<usize> = (0..=b.len()).collect();
        for (i, x) in a.iter().enumerate() {
            let mut diagonal = row[0];
            row[0] = i + 1;
            for (j, y) in b.iter().enumerate() {
                let above = row[j + 1];
                row[j + 1] = (row[j] + 1).min(above + 1).min(diagonal + usize::from(x != y));
                diagonal = above;
            }
        }
        row[b.len()] as f64 / a.len().max(1) as f64
    }

    #[test]
    #[ignore = "requires model weights in TX_DICTATION_MODELS"]
    fn each_cards_live_words_is_what_its_weights_say() {
        for (spec, path) in installed() {
            let loading = Instant::now();
            let local = Engine::default().open(spec.id, &path, &RunContext::default()).unwrap();
            let loaded = loading.elapsed();
            assert_eq!(local.streams(), spec.live_words, "{}: the card and capabilities().supports_streaming disagree", spec.id);
            eprintln!("{}: live words {}, loaded in {loaded:?}", spec.id, local.streams());
        }
    }

    /// The microphone at its own pace: ten-millisecond chunks, in real time.
    /// Answers when the reader pressed Stop.
    fn speak(speech: Vec<f32>, stopped: Arc<AtomicBool>) -> (mpsc::Receiver<Vec<f32>>, std::thread::JoinHandle<Instant>) {
        let (tx, rx) = mpsc::channel();
        let mic = std::thread::spawn(move || {
            let started = Instant::now();
            for (i, chunk) in speech.chunks(TARGET_RATE as usize / 100).enumerate() {
                tx.send(chunk.to_vec()).unwrap();
                let due = started + Duration::from_millis(10 * (i as u64 + 1));
                std::thread::sleep(due.saturating_duration_since(Instant::now()));
            }
            stopped.store(true, Ordering::SeqCst);
            Instant::now()
        });
        (rx, mic)
    }

    #[test]
    #[ignore = "requires a streaming model's weights in TX_DICTATION_MODELS, and macOS `say`"]
    fn a_streaming_model_shows_words_before_stop_and_ends_on_them() {
        // About half a minute: four sentences with a pause after each. Long
        // enough that the whole-recording run Stop used to start costs more
        // than the stream's last chunk does (on Apple Silicon, warm, the run
        // grows about 10 ms a second and finishing the stream stays near
        // 60-130 ms; below about ten seconds the two are on a par).
        let sentence = spoken(SPOKEN);
        let mut speech = Vec::new();
        for _ in 0..4 {
            speech.extend_from_slice(&sentence);
            speech.extend(std::iter::repeat_n(0.0, TARGET_RATE as usize / 2));
        }
        let said = [SPOKEN; 4].join(" ");
        let streaming: Vec<_> = installed().into_iter().filter(|(spec, _)| spec.live_words).collect();
        assert!(!streaming.is_empty(), "no streaming model among the weights given");
        for (spec, path) in streaming {
            let engine = Engine::default();
            let mut local = engine.open(spec.id, &path, &RunContext::default()).unwrap();
            assert!(local.streams(), "{}", spec.id);
            // What a dictation did before: the whole recording after Stop.
            // Twice, so the second is warm, as a stream's feeds are by its end.
            local.transcribe(&speech).unwrap();
            let run_started = Instant::now();
            let whole = local.transcribe(&speech).unwrap();
            let whole_run = run_started.elapsed();

            let stopped = Arc::new(AtomicBool::new(false));
            let mut stream = local.stream().unwrap();
            let mic_started = Instant::now();
            let (frames, mic) = speak(speech.clone(), stopped.clone());
            let shown = Mutex::new(Vec::<(String, bool)>::new());
            let first = Mutex::new(None::<Instant>);
            let heard = live::listen(frames, Some(&mut stream), &AtomicBool::new(false), |text| {
                first.lock().unwrap().get_or_insert_with(Instant::now);
                shown.lock().unwrap().push((text.to_string(), stopped.load(Ordering::SeqCst)));
            }, |reason| panic!("{}: the stream broke: {reason}", spec.id))
            .unwrap();
            let done = Instant::now();
            drop(stream);
            let stop_pressed = mic.join().unwrap();
            let after_stop = done - stop_pressed;

            let shown = shown.into_inner().unwrap();
            let Ending::Streamed(final_text) = heard.ending else { panic!("{}: streamed to the end", spec.id) };
            eprintln!("{}: {} partials, {} before stop", spec.id, shown.len(), shown.iter().filter(|(_, s)| !s).count());
            for (text, after) in shown.iter().rev().take(3).rev() {
                eprintln!("  {} {text}", if *after { "after stop    " } else { "while speaking" });
            }
            eprintln!("  final:  {final_text}");
            eprintln!("  whole:  {whole}");
            eprintln!("  first words after {:?} of speech", first.lock().unwrap().map(|at| at - mic_started));
            eprintln!("  wait after stop {after_stop:?}; whole recording after stop took {whole_run:?}");

            assert_eq!(heard.samples.len(), speech.len());
            let while_speaking: Vec<_> = shown.iter().filter(|(_, after)| !after).collect();
            assert!(while_speaking.len() >= 2, "{}: words shown while speaking: {shown:?}", spec.id);
            // The final carries on from the last thing shown: every word of it
            // but the last, which the model may still revise, then the rest.
            let last = words(&shown.last().unwrap().0);
            let end = words(&final_text);
            let settled = &last[..last.len() - 1];
            assert_eq!(&end[..settled.len()], settled, "{}: words dropped or changed at the boundary", spec.id);
            // Nothing doubled at the seam, and the words are the ones said.
            assert!(wer(&said, &final_text) <= 0.15, "{}: {final_text:?}", spec.id);
            assert!(end.len() <= words(&said).len() + 2, "{}: {final_text:?}", spec.id);
            // Stop only finishes the stream: shorter than starting over.
            assert!(after_stop < whole_run, "{}: {after_stop:?} after stop, against {whole_run:?} for the whole", spec.id);
        }
    }
}
