//! Running audio through a local model. Loading takes seconds and hundreds of
//! megabytes, so the loaded model is kept between dictations and only let go
//! when the selection changes or the weights are deleted.

#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use anyhow::{anyhow, Result};

pub const TARGET_RATE: u32 = 16_000;

#[cfg(target_os = "macos")]
struct Loaded {
    id: String,
    model: transcribe_cpp::Model,
}
// The model is only ever driven from inside the mutex, one run at a time.
#[cfg(target_os = "macos")]
unsafe impl Send for Loaded {}

#[cfg(target_os = "macos")]
#[derive(Default)]
pub struct Engine {
    loaded: Mutex<Option<Loaded>>,
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

    /// Transcribe 16 kHz mono audio, loading `path` first if it is not the
    /// model already in hand. Blocking; call from a worker thread.
    pub fn transcribe(&self, id: &str, path: &Path, audio: &[f32], context: &super::context::RunContext) -> Result<String> {
        // A quarter second cannot hold a word; loading a model for it would
        // cost seconds and answer with nothing or an invented one.
        if audio.len() < TARGET_RATE as usize / 4 {
            return Ok(String::new());
        }
        let options = run_options(id, context)?;
        let mut guard = self.loaded.lock().unwrap();
        if guard.as_ref().map(|l| l.id != id).unwrap_or(true) {
            let model = transcribe_cpp::Model::load(path).map_err(|e| anyhow!("could not load the model: {e}"))?;
            *guard = Some(Loaded { id: id.into(), model });
        }
        let loaded = guard.as_ref().expect("just loaded");
        let mut session = loaded.model.session().map_err(|e| anyhow!("could not open a session: {e}"))?;
        let transcript = session.run(audio, &options).map_err(|e| anyhow!("transcription failed: {e}"))?;
        Ok(transcript.text.trim().to_string())
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
    _unavailable: (),
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
}
