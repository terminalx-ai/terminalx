//! Personalization commands stay local; none are exposed through workspace RPC.
use super::{
    context,
    personalization::{self, Personalization},
};

#[tauri::command]
pub fn transcription_personalization_load() -> Result<Personalization, String> {
    personalization::load().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transcription_personalization_save(
    data: Personalization,
) -> Result<Personalization, String> {
    personalization::save_revision(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transcription_personalization_reset() -> Result<Personalization, String> {
    personalization::reset().map_err(|e| e.to_string())?;
    personalization::load().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn transcription_personalization_export(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_absolute() {
        return Err("Choose an absolute export path with the save dialog.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let data = personalization::load().map_err(|e| e.to_string())?;
        crate::store::write_json(std::path::Path::new(&path), &data).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn transcription_project_terms(cwd: String) -> Result<Vec<String>, String> {
    let data = personalization::load().map_err(|e| e.to_string())?;
    if !data.options.context || !data.options.project {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || context::project_terms(std::path::Path::new(&cwd)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transcription_learn(
    request: context::ContextRequest,
    before: String,
    after: String,
) -> Result<bool, String> {
    let data = personalization::load().map_err(|e| e.to_string())?;
    if !data.options.learn
        || request.remote
        || request.sensitive
        || data.options.sensitive_targets.contains(&request.target)
        || personalization::is_sensitive(&request.composer)
        || request
            .terminal
            .iter()
            .any(|s| personalization::is_sensitive(s))
    {
        return Ok(false);
    }
    personalization::learn(&before, &after, request.project.as_deref()).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorRow {
    #[serde(flatten)]
    model: super::ModelRow,
    readiness: super::detector_file::Readiness,
}

#[tauri::command]
pub async fn transcription_detector(state: tauri::State<'_, crate::AppState>) -> Result<DetectorRow, String> {
    let downloads = state.transcription.downloads.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let spec = &super::catalog::DETECTOR;
        let readiness = super::detector_file::inspect();
        DetectorRow {
            model: super::ModelRow {
                spec: spec.clone(),
                installed: readiness == super::detector_file::Readiness::VerifiedFile,
                downloading: downloads.is_active(spec.id),
                progress: downloads.snapshot(spec.id), page: spec.page(),
            },
            readiness,
        }
    }).await.map_err(|e| e.to_string())
}
