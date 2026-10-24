//! Opt-in utterance detector. Only its temporary copy is peak-normalized;
//! recognition always receives the original PCM. Errors retain recognized text.
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoiseStatus {
    Disabled,
    Unsupported,
    Unavailable,
    InvalidModel,
    Failed,
    Cancelled,
    Speech,
    NoSpeech,
    NoAudio,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseResult {
    pub status: NoiseStatus,
    pub elapsed_us: u128,
}
impl NoiseResult {
    pub fn new(status: NoiseStatus) -> Self {
        Self {
            status,
            elapsed_us: 0,
        }
    }
    pub fn apply(&self, text: String) -> String {
        if self.status == NoiseStatus::NoSpeech {
            String::new()
        } else {
            text
        }
    }
}

#[derive(Default)]
pub struct NoiseGuard {
    #[cfg(target_os = "macos")]
    loaded: Mutex<Option<terminalx_dictation_detector::Detector>>,
    #[cfg(not(target_os = "macos"))]
    loaded: Mutex<()>,
}
impl NoiseGuard {
    pub fn unload(&self) {
        #[cfg(target_os = "macos")]
        {
            *self.loaded.lock().unwrap() = None;
        }
        #[cfg(not(target_os = "macos"))]
        {
            drop(self.loaded.lock().unwrap());
        }
    }

    pub fn evaluate(
        &self,
        enabled: bool,
        path: Option<&Path>,
        audio: &[f32],
        cancel: &AtomicBool,
    ) -> NoiseResult {
        // This check precedes all I/O, locking, allocation and inference.
        if !enabled {
            return NoiseResult::new(NoiseStatus::Disabled);
        }
        if cancel.load(Ordering::Relaxed) {
            return NoiseResult::new(NoiseStatus::Cancelled);
        }
        let start = std::time::Instant::now();
        let status = self.run(path, audio, cancel);
        NoiseResult {
            status,
            elapsed_us: start.elapsed().as_micros(),
        }
    }

    #[cfg(target_os = "macos")]
    fn run(&self, path: Option<&Path>, audio: &[f32], cancel: &AtomicBool) -> NoiseStatus {
        use std::io::Read;
        use terminalx_dictation_detector::{verify_model, Detector, MODEL_SIZE};
        let Some(path) = path else {
            return NoiseStatus::Unavailable;
        };
        // A deleted model must not keep operating from an old cached handle.
        let Ok(file) = std::fs::File::open(path) else {
            return NoiseStatus::Unavailable;
        };
        if file
            .metadata()
            .map(|m| !m.is_file() || m.len() != MODEL_SIZE as u64)
            .unwrap_or(true)
        {
            return NoiseStatus::InvalidModel;
        }
        let mut bytes = Vec::with_capacity(MODEL_SIZE + 1);
        if file
            .take(MODEL_SIZE as u64 + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return NoiseStatus::Unavailable;
        }
        if verify_model(&bytes).is_err() {
            return NoiseStatus::InvalidModel;
        }
        let mut loaded = self.loaded.lock().unwrap();
        if cancel.load(Ordering::Relaxed) {
            return NoiseStatus::Cancelled;
        }
        if loaded.is_none() {
            // Exact size/hash are verified before native parsing, from the same
            // owned byte buffer. A damaged cache never becomes an unchecked model.
            match Detector::from_verified_bytes(&bytes) {
                Ok(model) => *loaded = Some(model),
                Err(_) => return NoiseStatus::InvalidModel,
            }
        }
        let result = loaded
            .as_mut()
            .expect("loaded above")
            .probabilities(audio, true, cancel);
        if cancel.load(Ordering::Relaxed) {
            return NoiseStatus::Cancelled;
        }
        match result {
            Ok(probabilities) if probabilities.iter().any(|p| *p >= 0.5) => NoiseStatus::Speech,
            Ok(_) => NoiseStatus::NoSpeech,
            Err(_) => NoiseStatus::Failed,
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn run(&self, _path: Option<&Path>, _audio: &[f32], _cancel: &AtomicBool) -> NoiseStatus {
        NoiseStatus::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_path_never_touches_model_or_validates_audio() {
        let guard = NoiseGuard::default();
        let cancel = AtomicBool::new(true);
        let result = guard.evaluate(
            false,
            Some(Path::new("/does-not-exist")),
            &[f32::NAN],
            &cancel,
        );
        assert_eq!(result.status, NoiseStatus::Disabled);
        assert_eq!(result.elapsed_us, 0);
        assert_eq!(result.apply(" Original text. ".into()), " Original text. ");
    }
    #[test]
    fn only_successful_no_speech_detection_discards_text() {
        for status in [
            NoiseStatus::Disabled,
            NoiseStatus::Unsupported,
            NoiseStatus::Unavailable,
            NoiseStatus::InvalidModel,
            NoiseStatus::Failed,
            NoiseStatus::Cancelled,
            NoiseStatus::Speech,
            NoiseStatus::NoAudio,
        ] {
            assert_eq!(
                NoiseResult::new(status).apply("quiet speech".into()),
                "quiet speech"
            );
        }
        assert_eq!(
            NoiseResult::new(NoiseStatus::NoSpeech).apply("invented words".into()),
            ""
        );
    }
    #[test]
    fn cancellation_precedes_loading() {
        let result =
            NoiseGuard::default().evaluate(true, None, &[0.0; 512], &AtomicBool::new(true));
        assert_eq!(result.status, NoiseStatus::Cancelled);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn missing_and_corrupted_models_are_explicit_non_suppressing_results() {
        let guard = NoiseGuard::default();
        let cancel = AtomicBool::new(false);
        assert_eq!(
            guard.evaluate(true, None, &[0.0; 512], &cancel).status,
            NoiseStatus::Unavailable
        );
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bad.gguf");
        std::fs::write(&path, vec![0; terminalx_dictation_detector::MODEL_SIZE]).unwrap();
        assert_eq!(
            guard
                .evaluate(true, Some(&path), &[0.0; 512], &cancel)
                .status,
            NoiseStatus::InvalidModel
        );
    }
}
