//! Running audio through a local model. Loading takes seconds and hundreds of
//! megabytes, so the loaded model is kept between dictations and only let go
//! when the selection changes or the weights are deleted.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Result};

pub const TARGET_RATE: u32 = 16_000;

struct Loaded {
    id: String,
    model: transcribe_cpp::Model,
}
// The model is only ever driven from inside the mutex, one run at a time.
unsafe impl Send for Loaded {}

#[derive(Default)]
pub struct Engine {
    loaded: Mutex<Option<Loaded>>,
}

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
    pub fn transcribe(&self, id: &str, path: &Path, audio: &[f32]) -> Result<String> {
        // A quarter second cannot hold a word; loading a model for it would
        // cost seconds and answer with nothing or an invented one.
        if audio.len() < TARGET_RATE as usize / 4 {
            return Ok(String::new());
        }
        let mut guard = self.loaded.lock().unwrap();
        if guard.as_ref().map(|l| l.id != id).unwrap_or(true) {
            let model = transcribe_cpp::Model::load(path).map_err(|e| anyhow!("could not load the model: {e}"))?;
            *guard = Some(Loaded { id: id.into(), model });
        }
        let loaded = guard.as_ref().expect("just loaded");
        let mut session = loaded.model.session().map_err(|e| anyhow!("could not open a session: {e}"))?;
        let options = transcribe_cpp::RunOptions::default();
        let transcript = session.run(audio, &options).map_err(|e| anyhow!("transcription failed: {e}"))?;
        Ok(transcript.text.trim().to_string())
    }
}
