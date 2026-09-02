//! Local speech models on offer. A fixed list compiled in, because the set
//! changes about as often as a release does and the settings screen must work
//! offline once a model is on disk. Weights come from Hugging Face, pinned to
//! a revision so a URL keeps naming the bytes its checksum describes.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    /// What it understands, as a phrase: a short list is worth naming, a long
    /// one is only ever a count.
    pub languages: &'static str,
    /// The weights' own licence, which is the upstream model's and not
    /// Raccoon's — a download is a separate grant from the one covering the
    /// app. Shown next to the model so nobody has to guess before fetching a
    /// few hundred megabytes.
    pub license: &'static str,
    pub license_url: &'static str,
    /// Relative to each other, 0–100. Not a benchmark: they answer "which of
    /// these", nothing about seconds or word error rate.
    pub speed: u8,
    pub accuracy: u8,
    pub recommended: bool,
}

impl ModelSpec {
    pub fn url(&self) -> String {
        format!("https://huggingface.co/{}/resolve/{}/{}", self.repo, self.revision, self.filename)
    }

    pub fn page(&self) -> String {
        format!("https://huggingface.co/{}", self.repo)
    }
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "parakeet-unified-en-0.6b",
        name: "Parakeet Unified EN 0.6B",
        description: "Quick and precise for English. The one to pick on Apple Silicon.",
        repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
        revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
        filename: "parakeet-unified-en-0.6b-Q8_0.gguf",
        size_bytes: 731_357_568,
        sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
        languages: "English",
        license: "NVIDIA Open Model License",
        license_url: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
        speed: 79,
        accuracy: 90,
        recommended: true,
    },
    ModelSpec {
        id: "nemotron-3.5-asr-streaming-0.6b",
        name: "Nemotron Streaming 3.5",
        description: "Quick, and the only one here that copes with two languages in a single sentence.",
        repo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
        revision: "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb",
        filename: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
        size_bytes: 751_094_240,
        sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
        languages: "28 languages",
        license: "OpenMDW-1.1",
        license_url: "https://openmdw.ai/license/1-1/",
        speed: 84,
        accuracy: 82,
        recommended: false,
    },
    ModelSpec {
        id: "canary-180m-flash",
        name: "Canary 180M Flash",
        description: "Small and immediate. Comfortable on any machine.",
        repo: "handy-computer/canary-180m-flash-gguf",
        revision: "b147f9dc52b59f0998e410540a84727bd86457fd",
        filename: "canary-180m-flash-Q8_0.gguf",
        size_bytes: 218_447_552,
        sha256: "e13c7f5d0952b056a027cfffec13e3a3a134d1608babed24f983568f141e297c",
        languages: "English, German, Spanish, French",
        license: "CC-BY-4.0",
        license_url: "https://creativecommons.org/licenses/by/4.0/",
        speed: 98,
        accuracy: 88,
        recommended: false,
    },
    ModelSpec {
        id: "whisper-small",
        name: "Whisper Small",
        description: "Wide language reach in a modest download, with the language picked up automatically.",
        repo: "handy-computer/whisper-small-gguf",
        revision: "c0214bd34be9296695486f838e0142f900803159",
        filename: "whisper-small-Q8_0.gguf",
        size_bytes: 269_751_136,
        sha256: "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860",
        languages: "99 languages",
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        speed: 78,
        accuracy: 80,
        recommended: false,
    },
    ModelSpec {
        id: "whisper-large-v3-turbo",
        name: "Whisper Large v3 Turbo",
        description: "The broadest language reach in the list, and the slowest to answer.",
        repo: "handy-computer/whisper-large-v3-turbo-gguf",
        revision: "5eaf945c7978e564bae5b28a5b1639dd93c2bfb1",
        filename: "whisper-large-v3-turbo-Q8_0.gguf",
        size_bytes: 886_381_760,
        sha256: "b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183",
        languages: "100 languages",
        license: "MIT",
        license_url: "https://opensource.org/license/mit",
        speed: 35,
        accuracy: 88,
        recommended: false,
    },
];

pub fn find(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_urls_are_pinned() {
        let mut ids: Vec<&str> = MODELS.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), MODELS.len());
        for m in MODELS {
            assert!(m.url().contains(m.revision));
            assert_eq!(m.sha256.len(), 64);
            assert!(m.size_bytes > 0);
            // A weights download is its own licence grant, and the screen
            // that offers it has to be able to name one.
            assert!(!m.license.is_empty(), "{} has no licence", m.id);
            assert!(m.license_url.starts_with("https://"), "{} has no licence link", m.id);
        }
        assert_eq!(MODELS.iter().filter(|m| m.recommended).count(), 1);
    }
}
