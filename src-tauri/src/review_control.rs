//! Agent review annotations use the same authenticated control service as
//! other CLI calls, on both desktop and headless owners.
use super::*;
use crate::events::{Payload, ToolResult, ToolType};
use crate::store::review_comments::{self, Action, Anchor, Author, AuthorKind, Side};
use std::io::Read;
use std::path::Component;

impl ControlService {
    pub(super) fn review_comments(
        &self,
        command: &str,
        params: Value,
    ) -> Result<Value, ControlError> {
        // PRO-230 stores cloud UI notes on the desktop, not in a workspace
        // runtime. Refuse until that store has a shared cloud transport.
        if self.runtime_kind.as_deref() == Some("cloud-workspace") {
            return Err(ControlError::new(
                "unsupported",
                "Review comment commands currently support local workspaces only.",
                None::<String>,
            ));
        }
        // Ids select a tab; writes below also require its launch credential
        // and the pipeline's recorded reviewer role.
        let session_id = params["caller"]["session"]
            .as_str()
            .filter(|id| !id.is_empty());
        let tab_id = params["caller"]["tab"].as_str().filter(|id| !id.is_empty());
        let (session_id, tab_id) = session_id.zip(tab_id).ok_or_else(|| ControlError::invalid("Run review commands from a TerminalX agent tab (RACCOON_SESSION_ID and RACCOON_TAB_ID are required)."))?;
        let session = index::get(session_id)
            .map_err(|_| ControlError::not_found("The caller's session no longer exists."))?;
        let tab = session
            .tab(tab_id)
            .filter(|tab| !tab.is_terminal())
            .ok_or_else(|| {
                ControlError::not_found("The caller's agent tab no longer exists in this session.")
            })?;
        let workspace = review_comments::workspace_key(Path::new(&session.cwd))
            .map_err(ControlError::internal)?;
        let store = crate::store::root().map_err(ControlError::internal)?;
        if command == "review.comments" {
            let mut comments = review_comments::apply(&store, &workspace, Action::List)
                .map_err(ControlError::internal)?;
            comments.sort_by(|a, b| {
                (&a.path, a.start_line, a.end_line, &a.id).cmp(&(
                    &b.path,
                    b.start_line,
                    b.end_line,
                    &b.id,
                ))
            });
            return Ok(json!({"workspace": workspace, "comments": comments}));
        }
        if !self.manager.authenticates_cli(
            session_id,
            tab_id,
            params["hookToken"].as_str().unwrap_or_default(),
        ) {
            return Err(ControlError::new(
                "unauthorized",
                "The caller is not authenticated as this agent tab.",
                None::<String>,
            ));
        }
        use crate::issue_pipeline::{Role, Stage, State};
        let pipeline = crate::issue_pipeline::store::list()
            .map_err(ControlError::internal)?
            .into_iter()
            .find(|pipeline| !pipeline.stopped && pipeline.stage == Stage::Review
                && pipeline.state == State::Working
                && pipeline.role_of(session_id, tab_id) == Some(Role::Reviewer))
            .ok_or_else(|| ControlError::new("forbidden", "Only the pipeline's recorded reviewer can add review comments during its review.", None::<String>))?;

        // Unlike selectors, paths and review text must retain their whitespace.
        let required = |key: &str| {
            params[key]
                .as_str()
                .ok_or_else(|| ControlError::invalid(format!("Missing {key}.")))
        };
        let root = Path::new(&session.cwd)
            .canonicalize()
            .map_err(|error| ControlError::invalid(error.to_string()))?;
        let body = required("body")?;
        let mut anchor = prepare_anchor(&root, required("file")?, required("line")?, body)
            .map_err(|error| ControlError::invalid(error.to_string()))?;
        let reviewed_commit = pin_review(&root, &pipeline, &mut anchor)
            .map_err(|error| ControlError::invalid(error.to_string()))?;
        let author = Author {
            kind: AuthorKind::Agent,
            session_id: Some(session.id.clone()),
            tab_id: Some(tab.id.clone()),
            name: Some(agent_name(tab.title.as_deref().unwrap_or(&tab.harness))),
            extra: std::collections::BTreeMap::from([("role".into(), json!("reviewer"))]),
            ..Default::default()
        };
        let (comment, created) = review_comments::save_reviewer(
            &store,
            &workspace,
            anchor,
            body.into(),
            author,
            &reviewed_commit,
        )
        .map_err(ControlError::internal)?;
        let mut result = json!({"workspace": workspace, "comment": comment, "created": created});
        if !created {
            return Ok(result);
        }
        // Saved annotations get their own transcript call regardless of
        // the provider's shell wrapper or whether stdout was redirected.
        let call_id = format!("review-comment:{}", comment.id);
        let published = self
            .manager
            .publish_external(
                session_id,
                tab_id,
                Payload::ToolCallStarted {
                    call_id: call_id.clone(),
                    name: "terminalx.review.comment".into(),
                    tool_type: ToolType::Other,
                    input: comment_preview(&comment),
                    title: None,
                },
            )
            .and_then(|_| {
                self.manager.publish_external(
                    session_id,
                    tab_id,
                    Payload::ToolCallCompleted {
                        call_id,
                        result: ToolResult {
                            text: format!("Commented on {}:{}", comment.path, comment.start_line),
                            ..Default::default()
                        },
                    },
                )
            });
        if let Err(error) = published {
            // The store is already committed. Do not report a failed write
            // and invite duplicates if a tab was removed concurrently.
            result["transcriptWarning"] = json!(format!(
                "Comment saved, but the chat card could not be published: {error:#}"
            ));
        }
        Ok(result)
    }
}

fn agent_name(title: &str) -> String {
    let clean: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let name: String = clean
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect();
    if name.is_empty() {
        "Reviewer agent".into()
    } else {
        name
    }
}

/// Keep the full anchor in the store, not in every transcript event.
fn comment_preview(comment: &review_comments::Comment) -> Value {
    let mut preview = json!(comment);
    preview["lineText"] = json!(comment
        .line_text
        .split('\n')
        .take(20)
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(4096)
        .collect::<String>());
    preview["quoteTruncated"] =
        json!(preview["lineText"].as_str() != Some(comment.line_text.as_str()));
    preview["quotedLineCount"] = json!(comment.end_line - comment.start_line + 1);
    preview
}

/// Shared by the thin CLI and the server, which never trusts client validation.
pub(crate) fn line_range(value: &str) -> anyhow::Result<(usize, usize)> {
    let (start, end) = value.split_once('-').unwrap_or((value, value));
    let number = |part: &str| -> anyhow::Result<usize> {
        anyhow::ensure!(
            !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()),
            "--line must be N or N-M, with positive line numbers."
        );
        let number = part.parse::<u32>()? as usize;
        anyhow::ensure!(number > 0, "Line numbers start at 1.");
        Ok(number)
    };
    let (start, end) = (number(start)?, number(end)?);
    anyhow::ensure!(
        end >= start,
        "The last line must be at or after the first line."
    );
    anyhow::ensure!(
        end - start < 10_000,
        "A review comment can quote at most 10,000 lines."
    );
    Ok((start, end))
}

pub(crate) fn validate_body(body: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!body.trim().is_empty(), "--body cannot be empty.");
    anyhow::ensure!(body.len() <= 32 * 1024, "--body must be at most 32 KiB.");
    Ok(())
}

fn prepare_anchor(root: &Path, path: &str, lines: &str, body: &str) -> anyhow::Result<Anchor> {
    validate_body(body)?;
    let (start_line, end_line) = line_range(lines)?;
    anyhow::ensure!(
        !path.is_empty() && path.len() <= 4096 && !path.contains('\0'),
        "--file must name a file inside the workspace."
    );
    anyhow::ensure!(
        !Path::new(path)
            .components()
            .any(|part| part == Component::ParentDir),
        "--file cannot contain '..'."
    );
    let resolved = root.join(path).canonicalize()?;
    let relative = resolved
        .strip_prefix(root)
        .map_err(|_| anyhow::anyhow!("--file resolves outside the workspace."))?;
    let file = crate::workspace_file::open(root, &resolved)?;
    anyhow::ensure!(file.metadata()?.is_file(), "--file must be a regular file.");
    let mut bytes = Vec::new();
    file.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 4 * 1024 * 1024,
        "--file must be at most 4 MiB."
    );
    anyhow::ensure!(!bytes.contains(&0), "--file must be a text file.");
    let text = String::from_utf8(bytes)?
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines: Vec<_> = text.lines().collect();
    anyhow::ensure!(
        end_line <= lines.len(),
        "Line {end_line} is past the end of the file ({} lines).",
        lines.len()
    );
    let path = relative
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("--file must have a UTF-8 path."))?;
    let anchor = Anchor {
        path: path.replace(std::path::MAIN_SEPARATOR, "/"),
        side: Side::After,
        start_line,
        end_line,
        line_text: lines[start_line - 1..end_line].join("\n"),
        base: None,
        original_path: None,
        context_before: lines[start_line.saturating_sub(4)..start_line - 1]
            .iter()
            .map(|line| (*line).into())
            .collect(),
        context_after: lines[end_line..lines.len().min(end_line + 3)]
            .iter()
            .map(|line| (*line).into())
            .collect(),
    };
    review_comments::valid_anchor(&anchor, body)?;
    Ok(anchor)
}

/// Pin provenance to the reviewed commit and the same comparison tree as Branch view.
fn pin_review(
    root: &Path,
    pipeline: &crate::issue_pipeline::Pipeline,
    anchor: &mut Anchor,
) -> anyhow::Result<String> {
    let commit = pipeline
        .review_commit
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("The pipeline has no reviewed commit."))?;
    anyhow::ensure!(
        (40..=64).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid reviewed commit."
    );
    anyhow::ensure!(
        crate::git::head_commit(root).as_deref() == Some(commit),
        "The checkout moved since this review was requested."
    );
    let spec = format!("{commit}:{}", anchor.path);
    let size = crate::git::run(root, &["cat-file", "-s", &spec])?
        .trim()
        .parse::<u64>()?;
    anyhow::ensure!(size <= 4 * 1024 * 1024, "The reviewed file is too large.");
    let original = crate::git::blob_at(root, commit, &anchor.path)?
        .ok_or_else(|| anyhow::anyhow!("The file is not in the reviewed commit."))?
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines: Vec<_> = original.lines().collect();
    anyhow::ensure!(
        lines
            .get(anchor.start_line - 1..anchor.end_line)
            .is_some_and(|lines| lines.join("\n") == anchor.line_text),
        "These lines changed since the reviewed commit; leave the finding in the verdict."
    );
    // Context comes from the reviewed snapshot, even if other working lines changed.
    anchor.context_before = lines[anchor.start_line.saturating_sub(4)..anchor.start_line - 1]
        .iter()
        .map(|line| (*line).into())
        .collect();
    anchor.context_after = lines[anchor.end_line..lines.len().min(anchor.end_line + 3)]
        .iter()
        .map(|line| (*line).into())
        .collect();
    let target = &pipeline
        .pr
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("The pipeline has no pull request base."))?
        .base;
    let resolve = |name: &str| {
        crate::git::run(
            root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{name}^{{commit}}"),
            ],
        )
    };
    let target_commit = resolve(&format!("origin/{target}")).or_else(|_| resolve(target))?;
    let merge = crate::git::run(root, &["merge-base", commit, target_commit.trim()])?;
    let base = crate::git::run(root, &["rev-parse", &format!("{}^{{tree}}", merge.trim())])?
        .trim()
        .to_owned();
    anchor.original_path = crate::git::changes_between(root, &base, Some(commit))?
        .into_iter()
        .find(|f| f.path == anchor.path)
        .and_then(|f| f.old_path);
    anchor.base = Some(base);
    Ok(commit.to_owned())
}

#[cfg(test)]
#[path = "review_control_tests.rs"]
mod tests;
