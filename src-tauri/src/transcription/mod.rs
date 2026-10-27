//! Transcription: which engine turns the microphone into text. "apple" is
//! the system recogniser (always available, nothing to download); anything
//! else is a model from the catalog that runs locally once its weights are on
//! disk. Selection and input device live in settings so they survive restarts.

pub mod audio;
pub mod catalog;
pub mod download;
pub mod engine;

use std::sync::Arc;

use serde::Serialize;

use crate::store::settings;

pub const APPLE: &str = "apple";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    #[serde(flatten)]
    pub spec: catalog::ModelSpec,
    pub installed: bool,
    pub downloading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<download::DownloadProgress>,
    pub page: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionPreferences {
    /// "apple" or a catalog id.
    pub model: String,
    pub input_device: Option<String>,
    pub mute_while_recording: bool,
}

trait InputDeviceGateway: Send + Sync {
    fn list_inputs(&self) -> Vec<audio::InputDevice>;
}

struct SystemInputDevices;

impl InputDeviceGateway for SystemInputDevices {
    fn list_inputs(&self) -> Vec<audio::InputDevice> {
        audio::list_inputs()
    }
}

pub struct Transcription {
    pub downloads: Arc<download::Downloads>,
    pub engine: Arc<engine::Engine>,
    input_devices: Arc<dyn InputDeviceGateway>,
}

impl Default for Transcription {
    fn default() -> Self {
        Self {
            downloads: Arc::new(download::Downloads::default()),
            engine: Arc::new(engine::Engine::default()),
            input_devices: Arc::new(SystemInputDevices),
        }
    }
}

impl Transcription {
    pub fn models(&self) -> Vec<ModelRow> {
        catalog::MODELS
            .iter()
            .map(|spec| ModelRow {
                spec: spec.clone(),
                installed: download::is_installed(spec),
                downloading: self.downloads.is_active(spec.id),
                progress: self.downloads.snapshot(spec.id),
                page: spec.page(),
            })
            .collect()
    }

    /// Saved preferences only. This is safe to call while a page renders: it
    /// never touches CoreAudio or either macOS privacy service.
    pub fn preferences(&self) -> TranscriptionPreferences {
        let s = settings::load();
        TranscriptionPreferences {
            model: s.transcription_model.clone(),
            input_device: s.transcription_input_device.clone(),
            mute_while_recording: s.transcription_mute,
        }
    }

    /// Discover devices only after an explicit request, such as opening the
    /// picker. Some macOS/audio-driver combinations consult TCC even for this
    /// otherwise read-only operation.
    pub fn inputs(&self) -> Vec<audio::InputDevice> {
        self.input_devices.list_inputs()
    }

    /// The engine dictation should use right now: the chosen model if its
    /// weights are present, otherwise the system recogniser.
    pub fn effective_model(&self) -> String {
        let s = settings::load();
        if s.transcription_model == APPLE {
            return APPLE.into();
        }
        match catalog::find(&s.transcription_model) {
            Some(spec) if download::is_installed(spec) => spec.id.into(),
            _ => APPLE.into(),
        }
    }

    pub fn set_model(&self, id: &str) -> anyhow::Result<()> {
        if id != APPLE && catalog::find(id).is_none() {
            anyhow::bail!("unknown model {id}");
        }
        let mut s = settings::load();
        if s.transcription_model != id {
            self.engine.unload();
        }
        s.transcription_model = id.into();
        settings::save(&s)
    }

    pub fn set_input(&self, device: Option<String>) -> anyhow::Result<()> {
        let mut s = settings::load();
        s.transcription_input_device = device.filter(|d| !d.is_empty());
        settings::save(&s)
    }

    pub fn set_mute(&self, mute: bool) -> anyhow::Result<()> {
        let mut s = settings::load();
        s.transcription_mute = mute;
        settings::save(&s)
    }

    pub fn delete(&self, id: &str) -> anyhow::Result<()> {
        let spec = catalog::find(id).ok_or_else(|| anyhow::anyhow!("unknown model {id}"))?;
        self.downloads.cancel(id);
        self.engine.unload_if(id);
        download::delete(spec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct CountingInputDevices {
        calls: AtomicUsize,
    }

    impl InputDeviceGateway for CountingInputDevices {
        fn list_inputs(&self) -> Vec<audio::InputDevice> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        }
    }

    #[test]
    fn saved_preferences_do_not_enumerate_input_devices() {
        let gateway = Arc::new(CountingInputDevices::default());
        let transcription = Transcription {
            downloads: Arc::new(download::Downloads::default()),
            engine: Arc::new(engine::Engine::default()),
            input_devices: gateway.clone(),
        };

        let _ = transcription.preferences();
        assert_eq!(gateway.calls.load(Ordering::SeqCst), 0);

        let _ = transcription.inputs();
        assert_eq!(gateway.calls.load(Ordering::SeqCst), 1);
    }
}
