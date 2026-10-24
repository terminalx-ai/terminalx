//! Ephemeral per-recording context. Never read file contents or provider logs.
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter};

use super::personalization::{self, Personalization};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContextRequest {
    pub target: String,
    pub project: Option<String>,
    pub remote: bool,
    pub sensitive: bool,
    pub coding: bool,
    pub project_terms: Vec<String>,
    pub session: Vec<String>,
    pub terminal: Vec<String>,
    pub composer: String,
}

#[derive(Clone, Default)]
pub struct RunContext {
    pub data: Personalization,
    pub project: Option<String>,
    pub bias: Vec<String>,
    pub target: String,
    pub suppressed: bool,
}

impl RunContext {
    pub fn prepare(request: ContextRequest) -> Self {
        Self::from_data(personalization::load().unwrap_or_default(), request)
    }

    fn from_data(mut data: Personalization, request: ContextRequest) -> Self {
        let suppressed = request.sensitive
            || data.options.sensitive_targets.contains(&request.target)
            || personalization::is_sensitive(&request.composer)
            || request
                .terminal
                .iter()
                .any(|s| personalization::is_sensitive(s));
        if suppressed {
            return Self {
                target: request.target,
                suppressed: true,
                ..Self::default()
            };
        }
        if !request.coding {
            data.options.code = false;
        }
        let mut sources = Vec::new();
        if data.options.context && (!request.remote || data.options.remote_context) {
            // Unstructured drafts/terminal screens can contain pasted ignored-file
            // contents. They may promote already known names, never introduce
            // arbitrary new words into a prompt. File names and named tools are
            // supplied separately without reading their contents.
            let mut trusted = Vec::new();
            for (enabled, source) in [
                (data.options.session, &request.session),
                (data.options.project, &request.project_terms),
            ] {
                if enabled {
                    trusted.extend(
                        source
                            .iter()
                            .take(128)
                            .filter(|s| s.len() <= 512 && !personalization::is_sensitive(s))
                            .cloned(),
                    );
                }
            }
            let mut known: std::collections::HashSet<String> =
                trusted.iter().map(|s| s.to_lowercase()).collect();
            for term in trusted
                .iter()
                .chain(personalization::compile(&data, request.project.as_deref(), &[]).iter())
            {
                known.insert(term.to_lowercase());
                if let Some(name) = Path::new(term).file_name().and_then(|s| s.to_str()) {
                    known.insert(name.to_lowercase());
                }
                if let Some(stem) = Path::new(term).file_stem().and_then(|s| s.to_str()) {
                    known.insert(stem.to_lowercase());
                }
            }
            let mut nearby = Vec::new();
            if data.options.composer {
                nearby.push(request.composer.clone());
            }
            if data.options.terminal {
                nearby.extend(request.terminal.iter().take(128).cloned());
            }
            sources.extend(
                personalization::compile(&data, request.project.as_deref(), &nearby)
                    .into_iter()
                    .filter(|term| known.contains(&term.to_lowercase())),
            );
            sources.extend(trusted);
        }
        let bias = personalization::compile(&data, request.project.as_deref(), &sources);
        Self {
            data,
            project: request.project,
            bias,
            target: request.target,
            suppressed: false,
        }
    }

    pub fn process(&self, raw: &str, app: &AppHandle, engine: &str, diagnostic: bool) -> String {
        let bias = if engine == "apple" || engine.starts_with("whisper-") {
            self.bias.as_slice()
        } else {
            &[]
        };
        let final_text = personalization::process(raw, &self.data, self.project.as_deref(), bias);
        if diagnostic && self.target == "transcription-test" && !self.suppressed {
            #[derive(Clone, Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Diagnostic<'a> {
                target: &'a str,
                raw: &'a str,
                final_text: &'a str,
                bias_terms: &'a [String],
                engine: &'a str,
            }
            let _ = app.emit(
                "transcription_diagnostic",
                Diagnostic {
                    target: &self.target,
                    raw,
                    final_text: &final_text,
                    bias_terms: bias,
                    engine,
                },
            );
        }
        final_text
    }
}

/// Called ahead of recording, off the UI thread. Names only, no file contents,
/// no symlinks, hidden files, ignored entries or unbounded repository walk.
pub fn project_terms(root: &Path) -> Vec<String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(40);
    let mut terms = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(6))
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some("node_modules" | "target" | ".git" | ".raccoon")
            )
        })
        .build()
        .flatten()
    {
        if terms.len() >= 128 || std::time::Instant::now() >= deadline {
            break;
        }
        if entry
            .file_type()
            .is_some_and(|t| t.is_file() && !t.is_symlink())
        {
            if let Ok(path) = entry.path().strip_prefix(root) {
                let name = path.to_string_lossy().to_string();
                if !personalization::is_sensitive(&name) {
                    terms.push(name);
                }
            }
        }
    }
    terms.sort();
    terms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_source_remote_and_sensitive_gates_apply_before_compilation() {
        let mut data = Personalization::default();
        data.options.context = true;
        data.options.project = true;
        data.options.composer = true;
        let request = ContextRequest {
            target: "tab".into(),
            coding: true,
            project_terms: vec!["DictationEngine.rs".into()],
            session: vec!["UnselectedSessionTerm".into()],
            ..Default::default()
        };
        assert!(RunContext::from_data(data.clone(), request.clone())
            .bias
            .contains(&"DictationEngine.rs".into()));
        assert!(!RunContext::from_data(data.clone(), request.clone())
            .bias
            .contains(&"UnselectedSessionTerm".into()));
        let remote = ContextRequest {
            remote: true,
            ..request.clone()
        };
        assert!(RunContext::from_data(data.clone(), remote.clone())
            .bias
            .is_empty());
        data.options.remote_context = true;
        assert!(!RunContext::from_data(data.clone(), remote).bias.is_empty());
        data.options.sensitive_targets.push("tab".into());
        assert!(RunContext::from_data(data.clone(), request.clone())
            .bias
            .is_empty());
        data.options.sensitive_targets.clear();
        let password = ContextRequest {
            composer: "Password: invented-value".into(),
            ..request
        };
        assert!(RunContext::from_data(data, password).suppressed);
    }

    #[test]
    fn filtering_precedes_source_truncation_and_all_off_has_no_hints() {
        let request = ContextRequest {
            coding: true,
            project_terms: vec![format!(
                "PrivateMarker {} password: hidden",
                " ".repeat(600)
            )],
            ..Default::default()
        };
        assert!(
            RunContext::from_data(Personalization::default(), request.clone())
                .bias
                .is_empty()
        );
        let mut data = Personalization::default();
        data.options.context = true;
        data.options.project = true;
        assert!(RunContext::from_data(data, request).bias.is_empty());
    }

    #[test]
    fn pasted_unlabelled_private_content_cannot_introduce_bias_terms() {
        let mut data = Personalization::default();
        data.options.context = true;
        data.options.project = true;
        data.options.composer = true;
        data.options.terminal = true;
        let request = ContextRequest {
            project_terms: vec!["src/DictationEngine.rs".into()],
            composer: "Open DictationEngine and PrivateMarker".into(),
            terminal: vec!["UnlabelledPrivateValue".into()],
            ..Default::default()
        };
        let run = RunContext::from_data(data, request);
        assert!(run.bias.contains(&"DictationEngine".into()));
        assert!(!run.bias.iter().any(|term| term.contains("Private")));
    }

    #[test]
    fn project_context_never_reads_ignored_or_hidden_contents() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.path().join(".env"), "PRIVATE_SENTINEL").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "IGNORED_SENTINEL").unwrap();
        std::fs::write(dir.path().join("DictationEngine.rs"), "CONTENT_SENTINEL").unwrap();
        assert_eq!(project_terms(dir.path()), vec!["DictationEngine.rs"]);
    }
}
