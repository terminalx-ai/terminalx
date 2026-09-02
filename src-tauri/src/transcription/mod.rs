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
pub struct TranscriptionSettings {
    /// "apple" or a catalog id.
    pub model: String,
    pub input_device: Option<String>,
    pub mute_while_recording: bool,
    pub inputs: Vec<audio::InputDevice>,
}

#[derive(Default)]
pub struct Transcription {
    pub downloads: Arc<download::Downloads>,
    pub engine: Arc<engine::Engine>,
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

    pub fn settings(&self) -> TranscriptionSettings {
        let s = settings::load();
        TranscriptionSettings {
            model: s.transcription_model.clone(),
            input_device: s.transcription_input_device.clone(),
            mute_while_recording: s.transcription_mute,
            inputs: audio::list_inputs(),
        }
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
