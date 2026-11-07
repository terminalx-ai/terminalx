//! Personal diff review notes, scoped to a workspace (including its repository).
//! Transactions lock a stable sidecar across windows/processes and replace JSON atomically.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Before,
    After,
}

/// Shared by personal notes, pipeline reviewers and imported GitHub threads.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub kind: AuthorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorKind {
    #[default]
    User,
    Agent,
    Github,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub revision: u64,
    pub path: String,
    pub side: Side,
    pub start_line: usize,
    pub end_line: usize,
    pub line_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(default)]
    pub context_before: Vec<String>,
    #[serde(default)]
    pub context_after: Vec<String>,
    #[serde(default)]
    pub text_hash: String,
    #[serde(default)]
    pub anchor_hash: String,
    #[serde(default)]
    pub author: Author,
    #[serde(default)]
    pub created_at: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
    pub note: String,
    pub sent: bool,
    pub outdated: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub path: String,
    pub side: Side,
    pub start_line: usize,
    pub end_line: usize,
    pub line_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(default)]
    pub context_before: Vec<String>,
    #[serde(default)]
    pub context_after: Vec<String>,
}

#[derive(Deserialize)]
pub struct Revision {
    pub id: String,
    pub revision: u64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    List,
    Save {
        anchor: Box<Anchor>,
        note: String,
        expected: Option<Revision>,
        #[serde(default)]
        author: Author,
    },
    Delete {
        expected: Revision,
    },
    Sent {
        comments: Vec<Revision>,
    },
    Reconcile {
        path: String,
        base: String,
        before: Option<String>,
        after: Option<String>,
        comments: Vec<Revision>,
    },
}

fn valid_anchor(anchor: &Anchor, note: &str) -> Result<()> {
    if anchor.base.as_ref().is_some_and(|base| {
        !(7..=64).contains(&base.len()) || !base.bytes().all(|b| b.is_ascii_hexdigit())
    }) {
        bail!("Invalid review comment base tree");
    }
    if let Some(original) = &anchor.original_path {
        valid_path(original)?;
    }
    if anchor.context_before.len() > 3
        || anchor.context_after.len() > 3
        || anchor
            .context_before
            .iter()
            .chain(&anchor.context_after)
            .any(|s| s.contains(['\n', '\r']) || s.len() > 1_000_000)
    {
        bail!("Invalid review comment context");
    }
    valid_path(&anchor.path)?;
    valid_range(anchor, note)
}

fn valid_path(value: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 4096
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || value.contains(['\n', '\r', '\0'])
    {
        bail!("Invalid review comment path");
    }
    Ok(())
}

fn valid_range(anchor: &Anchor, note: &str) -> Result<()> {
    if anchor.start_line == 0
        || anchor.end_line < anchor.start_line
        || anchor.end_line - anchor.start_line >= 10_000
        || anchor.line_text.len() > 1_000_000
        || note.len() > 100_000
        || note.trim().is_empty()
    {
        bail!("Invalid review comment range or note");
    }
    if anchor.line_text.split('\n').count() != anchor.end_line - anchor.start_line + 1 {
        bail!("Quoted lines do not match the review comment range");
    }
    Ok(())
}

/// Relocate only exact text. Context disambiguates duplicates; ambiguity is
/// unplaced, never evidence that the text disappeared. Keep this in sync with reviewAnchors.ts.
fn locate(comment: &Comment, content: Option<&str>) -> (bool, Option<usize>) {
    let Some(content) = content else {
        return (false, None);
    };
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<_> = normalized.split('\n').collect();
    let quote: Vec<_> = comment.line_text.split('\n').collect();
    // KMP avoids quadratic scans for long selections of repeated lines.
    let mut fallback = vec![0; quote.len()];
    let mut matched = 0;
    for index in 1..quote.len() {
        while matched > 0 && quote[index] != quote[matched] {
            matched = fallback[matched - 1];
        }
        if quote[index] == quote[matched] {
            matched += 1;
        }
        fallback[index] = matched;
    }
    let (mut candidates, mut contextual, mut candidate, mut context) = (0, 0, 0, 0);
    matched = 0;
    for (index, line) in lines.iter().enumerate() {
        while matched > 0 && *line != quote[matched] {
            matched = fallback[matched - 1];
        }
        if *line == quote[matched] {
            matched += 1;
        }
        if matched != quote.len() {
            continue;
        }
        let start = index + 1 - quote.len();
        candidates += 1;
        candidate = start + 1;
        let left = &comment.context_before;
        let right = &comment.context_after;
        if start >= left.len()
            && index + 1 + right.len() <= lines.len()
            && lines[start - left.len()..start] == *left
            && lines[index + 1..index + 1 + right.len()] == *right
        {
            contextual += 1;
            context = start + 1;
        }
        matched = fallback[matched - 1];
    }
    let position = if contextual == 1 {
        Some(context)
    } else if candidates == 1 {
        Some(candidate)
    } else {
        None
    };
    (candidates > 0, position)
}

/// The common key for desktop, control API and pipeline callers. Resolve it
/// while the worktree still exists, including when scheduling its deletion.
pub fn workspace_key(path: &Path) -> Result<String> {
    Ok(format!("local:{}", path.canonicalize()?.to_string_lossy()))
}

fn file(root: &Path, workspace: &str) -> Result<PathBuf> {
    if workspace.is_empty() || workspace.len() > 8192 {
        bail!("Invalid review workspace");
    }
    let dir = super::ensure_dir(root.join("review-comments"))?;
    Ok(dir.join(format!("{:x}.json", Sha256::digest(workspace.as_bytes()))))
}

const MAX_STORE_BYTES: u64 = 16 * 1024 * 1024;

pub fn apply(root: &Path, workspace: &str, action: Action) -> Result<Vec<Comment>> {
    // A directory-level lock remains stable while individual workspaces are deleted.
    super::transaction::run(
        &root.join("review-comments.lock"),
        Duration::from_secs(5),
        || {
            let key = match workspace.strip_prefix("local:") {
                Some(local) => workspace_key(Path::new(local))?,
                None => workspace.to_owned(),
            };
            let path = file(root, &key)?;
            // Migrate pre-canonical desktop keys without losing notes.
            let legacy = file(root, workspace)?;
            if path != legacy && !path.exists() && legacy.exists() {
                fs::rename(&legacy, &path)?;
                match fs::remove_file(legacy.with_extension("lock")) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }

            if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_STORE_BYTES) {
                bail!("Review comment store is too large");
            }
            let mut document: serde_json::Value = match fs::read(&path) {
                Ok(bytes) => serde_json::from_slice(&bytes).context("Read review comments")?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    serde_json::json!({"version": 1, "comments": []})
                }
                Err(e) => return Err(e.into()),
            };
            if document.is_array() {
                document = serde_json::json!({"version": 1, "comments": document});
            }
            let mut comments: Vec<Comment> = serde_json::from_value(
                document
                    .get("comments")
                    .context("Missing review comments")?
                    .clone(),
            )?;
            for c in &comments {
                valid_anchor(
                    &Anchor {
                        path: c.path.clone(),
                        side: c.side.clone(),
                        start_line: c.start_line,
                        end_line: c.end_line,
                        line_text: c.line_text.clone(),
                        base: c.base.clone(),
                        original_path: c.original_path.clone(),
                        context_before: c.context_before.clone(),
                        context_after: c.context_after.clone(),
                    },
                    &c.note,
                )
                .context("Invalid saved review comment")?;
            }
            let mut changed = true;
            match action {
                Action::List => changed = false,
                Action::Save {
                    anchor,
                    note,
                    expected,
                    author,
                } => {
                    valid_anchor(&anchor, &note)?;
                    if let Some(expected) = expected {
                        let c = comments
                            .iter_mut()
                            .find(|c| c.id == expected.id && c.revision == expected.revision)
                            .context("This comment changed. Refresh before editing it again.")?;
                        // Editing a note never silently reanchors its original quotation.
                        c.note = note.trim().to_owned();
                        c.revision = c
                            .revision
                            .checked_add(1)
                            .context("Review revision exhausted")?;
                        c.sent = false;
                    } else {
                        if anchor.base.is_none() {
                            bail!("A base tree is required for a new review comment");
                        }
                        if comments.len() >= 10_000 {
                            bail!("Too many review comments in this workspace");
                        }
                        comments.push(Comment {
                            text_hash: format!("{:x}", Sha256::digest(anchor.line_text.as_bytes())),
                            anchor_hash: format!(
                                "{:x}",
                                Sha256::digest(serde_json::to_vec(&(
                                    &anchor.context_before,
                                    &anchor.line_text,
                                    &anchor.context_after
                                ))?)
                            ),
                            context_before: anchor.context_before,
                            context_after: anchor.context_after,
                            author,
                            created_at: chrono::Utc::now().to_rfc3339(),
                            extra: BTreeMap::new(),
                            id: uuid::Uuid::now_v7().to_string(),
                            revision: 1,
                            path: anchor.path,
                            side: anchor.side,
                            start_line: anchor.start_line,
                            end_line: anchor.end_line,
                            line_text: anchor.line_text,
                            base: anchor.base,
                            original_path: anchor.original_path,
                            note: note.trim().to_owned(),
                            sent: false,
                            outdated: false,
                        });
                    }
                }
                Action::Delete { expected } => {
                    let index = comments
                        .iter()
                        .position(|c| c.id == expected.id && c.revision == expected.revision)
                        .context("This comment changed. Refresh before deleting it.")?;
                    comments.remove(index);
                }
                Action::Sent { comments: sent } => {
                    changed = false;
                    for c in &mut comments {
                        if !c.sent
                            && sent
                                .iter()
                                .any(|s| s.id == c.id && s.revision == c.revision)
                        {
                            c.sent = true;
                            changed = true;
                        }
                    }
                }
                Action::Reconcile {
                    path,
                    base,
                    before,
                    after,
                    comments: expected,
                } => {
                    changed = false;
                    for c in comments.iter_mut().filter(|c| {
                        c.path == path
                            && c.base.as_deref() == Some(base.as_str())
                            && expected
                                .iter()
                                .any(|e| e.id == c.id && e.revision == c.revision)
                    }) {
                        let content = match c.side {
                            Side::Before => before.as_deref(),
                            Side::After => after.as_deref(),
                        };
                        let (exists, position) = locate(c, content);
                        if c.outdated == exists {
                            c.outdated = !exists;
                            changed = true;
                        }
                        if let Some(start) = position {
                            if c.start_line != start {
                                c.end_line = (c.end_line - c.start_line) + start;
                                c.start_line = start;
                                changed = true;
                            }
                        }
                    }
                }
            }
            if changed {
                document["comments"] = serde_json::to_value(&comments)?;
                let bytes = serde_json::to_vec(&document)?;
                if bytes.len() as u64 > MAX_STORE_BYTES {
                    bail!(
                        "Review comment store is full. Delete older comments before adding more."
                    );
                }
                super::write_atomic(&path, &bytes)?;
            }
            Ok(comments)
        },
    )
}

/// Call after a successful worktree removal. The stable directory lock also
/// makes concurrent saves fail canonicalization instead of recreating the file.
pub fn remove_workspace(root: &Path, canonical_path: &Path) -> Result<()> {
    super::transaction::run(
        &root.join("review-comments.lock"),
        Duration::from_secs(5),
        || {
            let path = file(root, &format!("local:{}", canonical_path.to_string_lossy()))?;
            for path in [path.clone(), path.with_extension("lock")] {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn save(note: &str, expected: Option<Revision>) -> Action {
        Action::Save {
            anchor: Box::new(Anchor {
                path: "src/a.ts".into(),
                side: Side::After,
                start_line: 2,
                end_line: 3,
                line_text: "two\nthree".into(),
                base: Some("a".repeat(40)),
                original_path: None,
                context_before: vec!["one".into()],
                context_after: vec![],
            }),
            note: note.into(),
            expected,
            author: Author::default(),
        }
    }
    fn revision(c: &Comment) -> Revision {
        Revision {
            id: c.id.clone(),
            revision: c.revision,
        }
    }
    #[test]
    fn survives_reopen_isolates_workspaces_and_checks_revisions() {
        let root = tempfile::tempdir().unwrap();
        let c = apply(root.path(), "workspace-a", save("rename", None))
            .unwrap()
            .remove(0);
        assert!(apply(root.path(), "workspace-b", Action::List)
            .unwrap()
            .is_empty());
        assert_eq!(
            apply(root.path(), "workspace-a", Action::List).unwrap()[0].note,
            "rename"
        );
        let edited = apply(
            root.path(),
            "workspace-a",
            save("rename again", Some(revision(&c))),
        )
        .unwrap()
        .remove(0);
        assert!(
            !apply(
                root.path(),
                "workspace-a",
                Action::Sent {
                    comments: vec![revision(&c)]
                }
            )
            .unwrap()[0]
                .sent
        );
        assert!(apply(
            root.path(),
            "workspace-a",
            Action::Delete {
                expected: revision(&c)
            }
        )
        .is_err());
        assert!(
            apply(
                root.path(),
                "workspace-a",
                Action::Sent {
                    comments: vec![revision(&edited)]
                }
            )
            .unwrap()[0]
                .sent
        );
        let edited = apply(
            root.path(),
            "workspace-a",
            save("new request", Some(revision(&edited))),
        )
        .unwrap()
        .remove(0);
        assert!(!edited.sent);
        assert!(apply(
            root.path(),
            "workspace-a",
            Action::Delete {
                expected: revision(&edited)
            }
        )
        .unwrap()
        .is_empty());
    }
    #[test]
    fn changed_or_deleted_lines_are_outdated_and_can_return() {
        let root = tempfile::tempdir().unwrap();
        let saved = apply(root.path(), "w", save("note", None))
            .unwrap()
            .remove(0);
        let reconcile = |after| Action::Reconcile {
            path: "src/a.ts".into(),
            base: "a".repeat(40),
            before: None,
            after,
            comments: vec![revision(&saved)],
        };
        assert!(
            !apply(
                root.path(),
                "w",
                reconcile(Some("one\ntwo\nthree\nfour".into()))
            )
            .unwrap()[0]
                .outdated
        );
        let changed = apply(root.path(), "w", reconcile(None)).unwrap().remove(0);
        assert!(changed.outdated);
        assert_eq!(changed.line_text, "two\nthree");
        assert!(
            !apply(root.path(), "w", reconcile(Some("one\ntwo\nthree".into()))).unwrap()[0]
                .outdated
        );
    }
    #[test]
    fn corruption_is_not_overwritten_and_invalid_ranges_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let mut action = save("note", None);
        if let Action::Save { anchor, .. } = &mut action {
            anchor.start_line = 0;
        }
        assert!(apply(root.path(), "w", action).is_err());
        let path = file(root.path(), "w").unwrap();
        fs::write(&path, "broken").unwrap();
        assert!(apply(root.path(), "w", save("note", None)).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken");
    }
    #[test]
    fn stale_reconciliation_does_not_invalidate_a_new_note() {
        let root = tempfile::tempdir().unwrap();
        let saved = apply(root.path(), "w", save("note", None))
            .unwrap()
            .remove(0);
        let changed = apply(root.path(), "w", save("edited", Some(revision(&saved))))
            .unwrap()
            .remove(0);
        let list = apply(
            root.path(),
            "w",
            Action::Reconcile {
                path: "src/a.ts".into(),
                base: "a".repeat(40),
                before: None,
                after: None,
                comments: vec![revision(&saved)],
            },
        )
        .unwrap();
        assert!(!list[0].outdated);
        assert_eq!(list[0].revision, changed.revision);
    }

    #[test]
    fn simultaneous_saves_keep_every_comment() {
        let root = tempfile::tempdir().unwrap();
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    apply(root.path(), "w", save("note", None)).unwrap();
                });
            }
        });
        assert_eq!(apply(root.path(), "w", Action::List).unwrap().len(), 8);
    }
    #[test]
    fn relocation_uses_text_and_context_and_refuses_a_different_base() {
        let root = tempfile::tempdir().unwrap();
        let saved = apply(root.path(), "w", save("note", None))
            .unwrap()
            .remove(0);
        let reconcile = |base: String, after: &str| Action::Reconcile {
            path: "src/a.ts".into(),
            base,
            before: None,
            after: Some(after.into()),
            comments: vec![revision(&saved)],
        };
        let shifted = apply(
            root.path(),
            "w",
            reconcile("a".repeat(40), "inserted\none\ntwo\nthree"),
        )
        .unwrap()
        .remove(0);
        assert_eq!(
            (shifted.start_line, shifted.end_line, shifted.outdated),
            (3, 4, false)
        );
        assert_eq!(shifted.text_hash, saved.text_hash);
        assert_eq!(shifted.anchor_hash, saved.anchor_hash);
        let unrelated = apply(root.path(), "w", reconcile("b".repeat(40), "unrelated"))
            .unwrap()
            .remove(0);
        assert!(!unrelated.outdated);
        let duplicate = apply(
            root.path(),
            "w",
            reconcile("a".repeat(40), "two\nthree\none\ntwo\nthree"),
        )
        .unwrap()
        .remove(0);
        assert_eq!(duplicate.start_line, 4);
        let ambiguous = apply(
            root.path(),
            "w",
            reconcile("a".repeat(40), "two\nthree\ntwo\nthree"),
        )
        .unwrap()
        .remove(0);
        assert!(!ambiguous.outdated);
        assert_eq!(
            locate(&ambiguous, Some("two\nthree\ntwo\nthree")),
            (true, None)
        );
    }

    #[test]
    fn shared_authors_and_future_metadata_survive_mutations_and_legacy_migration() {
        let root = tempfile::tempdir().unwrap();
        let mut action = save("agent note", None);
        if let Action::Save { author, .. } = &mut action {
            author.kind = AuthorKind::Agent;
            author.session_id = Some("session-1".into());
            author.name = Some("Reviewer".into());
        }
        let saved = apply(root.path(), "w", action).unwrap().remove(0);
        assert_eq!(saved.author.session_id.as_deref(), Some("session-1"));
        assert!(!saved.created_at.is_empty());
        assert_eq!(saved.anchor_hash.len(), 64);
        let mut legacy = serde_json::to_value(vec![saved.clone()]).unwrap();
        legacy[0]["githubThread"] = serde_json::json!({"id": "thread"});
        let path = file(root.path(), "w").unwrap();
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let sent = apply(
            root.path(),
            "w",
            Action::Sent {
                comments: vec![revision(&saved)],
            },
        )
        .unwrap();
        assert_eq!(sent[0].extra["githubThread"]["id"], "thread");
        let document: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(document["version"], 1);
        assert_eq!(document["comments"][0]["author"]["kind"], "agent");
    }

    #[test]
    fn deletion_removes_json_and_legacy_lock_and_late_saves_cannot_recreate_them() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let canonical = workspace.path().canonicalize().unwrap();
        let key = workspace_key(workspace.path()).unwrap();
        apply(root.path(), &key, save("note", None)).unwrap();
        let path = file(root.path(), &key).unwrap();
        fs::write(path.with_extension("lock"), "").unwrap();
        workspace.close().unwrap();
        remove_workspace(root.path(), &canonical).unwrap();
        assert!(!path.exists());
        assert!(!path.with_extension("lock").exists());
        assert!(apply(root.path(), &key, save("late", None)).is_err());
        assert!(!path.exists());
    }
}
