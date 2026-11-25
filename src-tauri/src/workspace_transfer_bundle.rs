//! A cloud-to-local transfer bundle contains one
//! pinned branch and never supplies a destination path or updates a ref.

use anyhow::{bail, ensure, Context, Result};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

const BUNDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const CHUNK_BYTES: u64 = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BranchCommit {
    branch_ref: String,
    commit: String,
}

impl BranchCommit {
    pub(crate) fn commit(&self) -> &str {
        &self.commit
    }

    pub(crate) fn branch(&self) -> &str {
        self.branch_ref
            .strip_prefix("refs/heads/")
            .expect("validated branch")
    }

    pub(crate) fn new(branch: &str, commit: &str) -> Result<Self> {
        ensure!(
            crate::remote::git::valid_ref_name(branch),
            "invalid transfer branch"
        );
        ensure!(
            matches!(commit.len(), 40 | 64) && commit.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "transfer needs a full commit id"
        );
        Ok(Self {
            branch_ref: format!("refs/heads/{branch}"),
            commit: commit.to_ascii_lowercase(),
        })
    }
}

pub(crate) struct TransferBundle {
    _directory: tempfile::TempDir,
    path: PathBuf,
    size: u64,
}

impl TransferBundle {
    pub(crate) fn size(&self) -> u64 {
        self.size
    }

    /// Read from the private, verified export. The attachment handler must
    /// authorize the current peer before returning each chunk.
    pub(crate) fn read_chunk(&self, offset: u64) -> Result<Vec<u8>> {
        ensure!(
            offset <= self.size,
            "transfer offset exceeds the bundle size"
        );
        let mut file = std::fs::File::open(&self.path)?;
        ensure!(
            file.metadata()?.len() == self.size,
            "the transfer bundle changed"
        );
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; (self.size - offset).min(CHUNK_BYTES) as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

pub(crate) fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let mut command = crate::git::git_in(repo, args);
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1");
    crate::git::output_within(command, BUNDLE_TIMEOUT)
        .map_err(|error| anyhow::anyhow!("transfer bundle: {error}"))
}

fn path_argument(path: &Path) -> Result<&str> {
    ensure!(
        path.is_absolute(),
        "transfer bundle needs a native storage path"
    );
    path.to_str().context("unsupported transfer bundle path")
}

pub(crate) fn export(repo: &Path, expected: &BranchCommit) -> Result<TransferBundle> {
    let head = git(repo, &["rev-parse", "--verify", &expected.branch_ref])?;
    ensure!(
        head.trim() == expected.commit,
        "cloud branch changed before export"
    );
    let directory = tempfile::Builder::new()
        .prefix("terminalx-transfer-")
        .tempdir()?;
    let path = directory.path().join("workspace.bundle");
    let base = ["@{upstream}", "refs/remotes/origin/HEAD"]
        .into_iter()
        .filter_map(|reference| git(repo, &["merge-base", expected.commit(), reference]).ok())
        .map(|base| base.trim().to_owned())
        .find(|base| base != expected.commit());
    let exclude = base.map(|base| format!("^{base}"));
    let mut args = vec![
        "bundle",
        "create",
        path_argument(&path)?,
        &expected.branch_ref,
    ];
    if let Some(exclude) = &exclude {
        args.push(exclude);
    }
    git(repo, &args)?;
    check_head(repo, &path, expected)?;
    let size = std::fs::metadata(&path)?.len();
    Ok(TransferBundle {
        _directory: directory,
        path,
        size,
    })
}

fn check_head(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<()> {
    let heads = git(repo, &["bundle", "list-heads", path_argument(bundle)?])?;
    let mut heads = heads.lines();
    let Some((commit, reference)) = heads.next().and_then(|line| line.split_once(' ')) else {
        bail!("the transfer bundle has no branch");
    };
    ensure!(
        commit == expected.commit && reference == expected.branch_ref && heads.next().is_none(),
        "the transfer bundle does not match the selected branch and commit"
    );
    Ok(())
}

/// Load Git objects only. The caller can create the named branch and
/// worktree after the transcript and destination have both been validated.
pub(crate) fn import_objects(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<()> {
    check_head(repo, bundle, expected)?;
    let bundle = path_argument(bundle)?;
    git(repo, &["bundle", "verify", bundle])?;
    git(repo, &["bundle", "unbundle", bundle])?;
    git(
        repo,
        &["cat-file", "-e", &format!("{}^{{commit}}", expected.commit)],
    )?;
    Ok(())
}

/// Install the pinned commit only after the caller has verified the imported
/// transcript and selected the destination. A concurrent branch creation
/// wins. An existing matching branch can be used on retry.
pub(crate) fn ensure_local_branch(repo: &Path, expected: &BranchCommit) -> Result<()> {
    let commit = format!("{}^{{commit}}", expected.commit);
    let resolved = git(repo, &["rev-parse", "--verify", &commit])?;
    ensure!(
        resolved.trim() == expected.commit,
        "transfer object is not the pinned commit"
    );

    let absent = "0".repeat(expected.commit.len());
    let create = git(
        repo,
        &[
            "update-ref",
            &expected.branch_ref,
            &expected.commit,
            &absent,
        ],
    );
    if create.is_ok() {
        return Ok(());
    }

    let existing = git(repo, &["rev-parse", "--verify", &expected.branch_ref]);
    if existing
        .as_ref()
        .is_ok_and(|head| head.trim() == expected.commit)
    {
        return Ok(());
    }
    if existing.is_ok() {
        bail!("a local branch with this name already points to a different commit");
    }
    create.map(|_| ())
}

#[derive(serde::Deserialize, serde::Serialize)]
// Transcript tags are lowercase. Message fields use the webview wire convention.
#[serde(
    tag = "role",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TranscriptMessage {
    User { text: String },
    Assistant { text: String },
}

pub(crate) fn transcript(events: &[crate::events::AgentEvent]) -> Result<Vec<u8>> {
    use crate::events::Payload;
    let mut messages = Vec::new();
    let mut assistant_seen = false;
    for event in events {
        match &event.payload {
            Payload::UserMessage {
                text,
                queued: false,
                ..
            } => {
                messages.push(TranscriptMessage::User { text: text.clone() });
                assistant_seen = false;
            }
            Payload::TurnStarted { .. } => assistant_seen = false,
            Payload::AssistantText { text, .. }
                if event.subagent.is_none() && !text.trim().is_empty() =>
            {
                messages.push(TranscriptMessage::Assistant { text: text.clone() });
                assistant_seen = true;
            }
            Payload::TurnCompleted {
                final_text: Some(text),
                ..
            } if !assistant_seen && event.subagent.is_none() => {
                messages.push(TranscriptMessage::Assistant { text: text.clone() });
                assistant_seen = true;
            }
            _ => {}
        }
    }
    Ok(serde_json::to_vec(&messages)?)
}

#[cfg(feature = "desktop")]
pub(crate) fn save_transcript(
    session: &crate::store::index::SessionEntry,
    messages: Vec<TranscriptMessage>,
) -> Result<()> {
    use crate::events::AgentEvent;
    use serde_json::json;
    use std::io::Write;
    let tab = session.tabs.first().context("No local conversation")?;
    let mut log = Vec::new();
    let mut sequence = 0;
    let mut write_event = |payload| -> Result<()> {
        sequence += 1;
        let event: AgentEvent = serde_json::from_value(json!({
            "id": uuid::Uuid::new_v4().to_string(), "sessionId": session.id, "tabId": tab.id,
            "harness": tab.harness, "seq": sequence, "ts": session.created,
            "payload": payload,
        }))?;
        serde_json::to_writer(&mut log, &event)?;
        log.push(b'\n');
        Ok(())
    };
    let mut turn = false;
    for message in messages {
        match message {
            TranscriptMessage::User { text } => {
                if turn {
                    write_event(json!({ "type": "turn_completed", "status": "ok" }))?;
                }
                write_event(json!({ "type": "user_message", "text": text }))?;
            }
            TranscriptMessage::Assistant { text } => {
                write_event(json!({ "type": "assistant_text", "text": text }))?
            }
        }
        turn = true;
    }
    if turn {
        write_event(json!({ "type": "turn_completed", "status": "ok" }))?;
    }
    let path = crate::store::log_path(&session.id, &tab.id)?;
    let mut staged =
        tempfile::NamedTempFile::new_in(path.parent().context("No transcript directory")?)?;
    staged.write_all(&log)?;
    staged.as_file().sync_all()?;
    staged
        .persist_noclobber(path)
        .context("The local conversation already has a transcript")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(path: &Path) {
        std::fs::create_dir(path).unwrap();
        git(path, &["init", "-q", "-b", "main"]).unwrap();
        git(path, &["config", "user.name", "Fixture"]).unwrap();
        git(path, &["config", "user.email", "fixture@example.test"]).unwrap();
    }

    fn commit(repo: &Path) -> String {
        git(
            repo,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        )
        .unwrap();
        git(repo, &["rev-parse", "HEAD"]).unwrap().trim().into()
    }

    #[test]
    fn exports_the_branch_without_a_remote_and_imports_its_objects_without_moving_a_local_ref() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        repository(&local);
        git(&cloud, &["switch", "-c", "topic/one"]).unwrap();
        let source = BranchCommit::new("topic/one", &commit(&cloud)).unwrap();
        let local_head = commit(&local);
        let bundle = export(&cloud, &source).unwrap();
        let mut received = Vec::new();
        while (received.len() as u64) < bundle.size() {
            let bytes = bundle.read_chunk(received.len() as u64).unwrap();
            assert!(!bytes.is_empty());
            assert!(bytes.len() as u64 <= CHUNK_BYTES);
            received.extend(bytes);
        }
        assert!(bundle.read_chunk(bundle.size()).unwrap().is_empty());
        assert!(bundle.read_chunk(bundle.size() + 1).is_err());
        let incoming = temp.path().join("incoming.bundle");
        std::fs::write(&incoming, received).unwrap();
        import_objects(&local, &incoming, &source).unwrap();
        assert_eq!(
            git(&local, &["rev-parse", "HEAD"]).unwrap().trim(),
            local_head
        );
        assert!(git(&local, &["show-ref", "--verify", &source.branch_ref]).is_err());
        assert_eq!(
            git(&local, &["cat-file", "-t", &source.commit])
                .unwrap()
                .trim(),
            "commit"
        );
    }

    #[test]
    fn exports_an_origin_delta_without_updating_the_remote_branch() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("origin");
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&origin);
        let base = commit(&origin);
        let source = origin.to_str().unwrap();
        for checkout in [&cloud, &local] {
            git(
                temp.path(),
                &["clone", "-q", source, checkout.to_str().unwrap()],
            )
            .unwrap();
            git(checkout, &["config", "user.name", "Fixture"]).unwrap();
            git(checkout, &["config", "user.email", "fixture@example.test"]).unwrap();
        }
        let head = commit(&cloud);
        let selected = BranchCommit::new("main", &head).unwrap();
        let bundle = export(&cloud, &selected).unwrap();
        assert_eq!(git(&origin, &["rev-parse", "main"]).unwrap().trim(), base);
        import_objects(&local, &bundle.path, &selected).unwrap();
        assert_eq!(git(&local, &["rev-parse", "main"]).unwrap().trim(), base);
        let missing_base = temp.path().join("missing-base");
        repository(&missing_base);
        assert!(import_objects(&missing_base, &bundle.path, &selected).is_err());
    }

    #[test]
    fn creates_only_the_pinned_local_branch_and_refuses_to_replace_it() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        repository(&local);
        let first = commit(&local);
        let second = commit(&local);
        let selected = BranchCommit::new("topic", &first).unwrap();
        ensure_local_branch(&local, &selected).unwrap();
        ensure_local_branch(&local, &selected).unwrap();
        let conflicting = BranchCommit::new("topic", &second).unwrap();
        assert!(ensure_local_branch(&local, &conflicting).is_err());
        assert_eq!(git(&local, &["rev-parse", "topic"]).unwrap().trim(), first);
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).unwrap().trim(), second);
    }

    #[test]
    fn bounds_each_chunk_and_rejects_a_changed_snapshot_length() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.bundle");
        let mut bytes = vec![1; CHUNK_BYTES as usize];
        bytes.extend_from_slice(&[2, 3]);
        std::fs::write(&path, &bytes).unwrap();
        let bundle = TransferBundle {
            _directory: directory,
            path,
            size: bytes.len() as u64,
        };
        assert_eq!(
            bundle.read_chunk(0).unwrap(),
            &bytes[..CHUNK_BYTES as usize]
        );
        assert_eq!(bundle.read_chunk(CHUNK_BYTES).unwrap(), [2, 3]);
        std::fs::write(&bundle.path, [0]).unwrap();
        assert!(bundle.read_chunk(0).is_err());
    }

    #[test]
    fn refuses_a_moved_branch_and_an_unexpected_bundle_head() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        repository(&local);
        let initial = BranchCommit::new("main", &commit(&cloud)).unwrap();
        let bundle = export(&cloud, &initial).unwrap();
        let moved = BranchCommit::new("main", &commit(&cloud)).unwrap();
        assert!(export(&cloud, &initial).is_err());
        assert!(import_objects(&local, &bundle.path, &moved).is_err());
        assert!(git(&local, &["cat-file", "-e", &initial.commit]).is_err());
    }
}
