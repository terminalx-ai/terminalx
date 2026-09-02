//! What the Claude harness needs to describe a tool call, a permission card
//! or a question in the app's own vocabulary.
//!
//! These are pure functions over the CLI's own JSON: the transcript tailer
//! uses them for the rows it draws, and the hook bridge uses them for the card
//! a `PermissionRequest` becomes.

use serde_json::Value;

use crate::events::*;

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

/// A short label for a tool row: verb-ish tool name plus its main target.
pub fn tool_title(name: &str, input: &Value) -> String {
    let target = ["file_path", "path", "command", "pattern", "query", "url", "description", "prompt", "notebook_path"]
        .iter()
        .find_map(|k| opt_str(input, k))
        .map(|s| {
            let s = s.lines().next().unwrap_or("").to_string();
            if s.chars().count() > 120 {
                format!("{}…", s.chars().take(120).collect::<String>())
            } else {
                s
            }
        });
    match target {
        Some(t) => format!("{name} {t}"),
        None => name.to_string(),
    }
}

pub fn file_edits_from_input(name: &str, input: &Value) -> Option<Vec<FileEdit>> {
    match name {
        "Edit" => Some(vec![FileEdit {
            path: opt_str(input, "file_path")?,
            old_text: opt_str(input, "old_string"),
            new_text: opt_str(input, "new_string"),
            unified: None,
            kind: EditKind::Update,
        }]),
        "MultiEdit" => {
            let path = opt_str(input, "file_path")?;
            let edits = input.get("edits")?.as_array()?;
            Some(
                edits
                    .iter()
                    .map(|e| FileEdit {
                        path: path.clone(),
                        old_text: opt_str(e, "old_string"),
                        new_text: opt_str(e, "new_string"),
                        unified: None,
                        kind: EditKind::Update,
                    })
                    .collect(),
            )
        }
        "Write" => Some(vec![FileEdit {
            path: opt_str(input, "file_path")?,
            old_text: None,
            new_text: opt_str(input, "content"),
            unified: None,
            kind: EditKind::Create,
        }]),
        _ => None,
    }
}

/// The questions of an `AskUserQuestion` call, as the chat's form draws them.
pub fn questions_from_input(input: &Value) -> Vec<Question> {
    input
        .get("questions")
        .and_then(|q| q.as_array())
        .map(|qs| {
            qs.iter()
                .map(|q| Question {
                    question: opt_str(q, "question").unwrap_or_default(),
                    header: opt_str(q, "header"),
                    multi_select: q.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false),
                    options: q
                        .get("options")
                        .and_then(|o| o.as_array())
                        .map(|os| {
                            os.iter()
                                .map(|o| QuestionOption { label: opt_str(o, "label").unwrap_or_default(), description: opt_str(o, "description") })
                                .collect()
                        })
                        .unwrap_or_default(),
                    free_text: true,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Options for a permission card. The first is always "allow once", the last
/// always "deny"; suggestions in between carry the CLI's own rule payloads,
/// which stay in Rust (keyed by option id) and never reach the frontend.
pub fn build_options(suggestions: &[Value]) -> Vec<PermissionOption> {
    let mut out = vec![PermissionOption { id: "allow".into(), label: "Allow".into(), kind: PermissionOptionKind::AllowOnce }];
    for (i, s) in suggestions.iter().enumerate() {
        let id = format!("suggest:{i}");
        match s.get("type").and_then(|t| t.as_str()) {
            Some("setMode") => {
                let mode = opt_str(s, "mode").unwrap_or_default();
                out.push(PermissionOption {
                    id,
                    label: format!("Allow and switch to {}", mode_label(&mode)),
                    kind: PermissionOptionKind::SwitchMode,
                });
            }
            Some("addRules") => {
                let rules: Vec<String> = s
                    .get("rules")
                    .and_then(|r| r.as_array())
                    .map(|rs| rs.iter().filter_map(|r| opt_str(r, "ruleContent").or_else(|| opt_str(r, "toolName"))).collect())
                    .unwrap_or_default();
                let label = match rules.as_slice() {
                    [] => "Always allow".to_string(),
                    [one] if one.chars().count() <= 48 => format!("Always allow {one}"),
                    [one] => format!("Always allow {}…", one.chars().take(40).collect::<String>().trim_end()),
                    many => format!("Always allow {} rules", many.len()),
                };
                out.push(PermissionOption { id, label, kind: PermissionOptionKind::AllowAlways });
            }
            Some("addDirectories") => {
                let dirs: Vec<String> = s
                    .get("directories")
                    .and_then(|d| d.as_array())
                    .map(|ds| ds.iter().filter_map(|d| d.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                out.push(PermissionOption {
                    id,
                    label: format!("Allow access to {}", dirs.join(", ")),
                    kind: PermissionOptionKind::AllowSession,
                });
            }
            _ => {}
        }
    }
    out.push(PermissionOption { id: "deny".into(), label: "Deny".into(), kind: PermissionOptionKind::Deny });
    out
}

pub fn mode_label(mode: &str) -> &'static str {
    match mode {
        "plan" => "Plan",
        "manual" => "Ask every time",
        "auto" => "Auto",
        "acceptEdits" => "Accept edits",
        "dontAsk" => "Don't ask",
        "bypassPermissions" => "Bypass permissions",
        _ => "Auto",
    }
}
