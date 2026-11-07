//! Personal diff review notes, scoped to a workspace (including its repository).
//! Transactions lock a stable sidecar across windows/processes and replace JSON atomically.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
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
    pub note: String,
    pub sent: bool,
    pub outdated: bool,
}

#[derive(Deserialize)]
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
        anchor: Anchor,
        note: String,
        expected: Option<Revision>,
    },
    Delete {
        expected: Revision,
    },
    Sent {
        comments: Vec<Revision>,
    },
    Reconcile {
        path: String,
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

fn matches_lines(comment: &Comment, content: Option<&str>) -> bool {
    let Some(content) = content else {
        return false;
    };
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<_> = normalized.split('\n').collect();
    lines
        .get(comment.start_line - 1..comment.end_line)
        .is_some_and(|lines| lines.join("\n") == comment.line_text)
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
    let path = file(root, workspace)?;
    super::transaction::run(&path.with_extension("lock"), Duration::from_secs(5), || {
        if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_STORE_BYTES) {
            bail!("Review comment store is too large");
        }
        let mut comments: Vec<Comment> = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("Read review comments")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
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
            } => {
                valid_anchor(&anchor, &note)?;
                if let Some(expected) = expected {
                    let c = comments
                        .iter_mut()
                        .find(|c| c.id == expected.id && c.revision == expected.revision)
                        .context("This comment changed. Refresh before editing it again.")?;
                    // Editing a note never silently reanchors its original quotation.
                    c.note = note.trim().to_owned();
                    c.revision += 1;
                    c.sent = false;
                } else {
                    if comments.len() >= 10_000 {
                        bail!("Too many review comments in this workspace");
                    }
                    comments.push(Comment {
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
                before,
                after,
                comments: expected,
            } => {
                changed = false;
                for c in comments.iter_mut().filter(|c| {
                    c.path == path
                        && !c.outdated
                        && expected
                            .iter()
                            .any(|e| e.id == c.id && e.revision == c.revision)
                }) {
                    let content = match c.side {
                        Side::Before => before.as_deref(),
                        Side::After => after.as_deref(),
                    };
                    if !matches_lines(c, content) {
                        c.outdated = true;
                        changed = true;
                    }
                }
            }
        }
        if changed {
            let bytes = serde_json::to_vec(&comments)?;
            if bytes.len() as u64 > MAX_STORE_BYTES {
                bail!("Review comment store is full. Delete older comments before adding more.");
            }
            super::write_atomic(&path, &bytes)?;
        }
        Ok(comments)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn save(note: &str, expected: Option<Revision>) -> Action {
        Action::Save {
            anchor: Anchor {
                path: "src/a.ts".into(),
                side: Side::After,
                start_line: 2,
                end_line: 3,
                line_text: "two\nthree".into(),
                base: None,
                original_path: None,
            },
            note: note.into(),
            expected,
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
    fn changed_or_deleted_lines_are_sticky_outdated_and_keep_the_quote() {
        let root = tempfile::tempdir().unwrap();
        let saved = apply(root.path(), "w", save("note", None))
            .unwrap()
            .remove(0);
        let reconcile = |after| Action::Reconcile {
            path: "src/a.ts".into(),
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
            apply(root.path(), "w", reconcile(Some("one\ntwo\nthree".into()))).unwrap()[0].outdated
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
}
