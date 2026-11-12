//! Session PR identities, independent of the session index and checkout lifetime.
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Scope {
    Local { cwd: String },
    Cloud { workspace: String, repo: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Association {
    pub url: String,
    pub number: u64,
    pub head: String,
    pub scope: Scope,
    /// Chosen by hand with "Link pull request…" (PRO-294), rather than
    /// recorded from this session's own creation. Only such a link can be
    /// unlinked; it does not make the PR this session's branch PR.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub linked: bool,
}

/// A canonical URL is both repository identity and PR identity (numbers alone aren't).
pub fn identity(raw: &str) -> Result<String> {
    let url = url::Url::parse(raw)?;
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || parts.len() != 4 || parts[2] != "pull" || parts[3].parse::<u64>().ok().filter(|n| *n > 0).is_none()
        || parts[..2].iter().any(|s| s.is_empty()) || url.query().is_some() || url.fragment().is_some() {
        bail!("Expected an HTTPS pull request URL (owner/repository/pull/number)");
    }
    Ok(format!("{}/{}/{}/pull/{}", url.origin().ascii_serialization(), parts[0].to_ascii_lowercase(), parts[1].to_ascii_lowercase(), parts[3].parse::<u64>()?))
}

type Associations = BTreeMap<String, BTreeMap<String, Association>>;

fn transaction<T>(path: &Path, change: impl FnOnce() -> Result<T>) -> Result<T> {
    // The desktop and local runtime share this cache. Protect the registry and
    // its checkpoints with one stable OS lock, including explicit PR recordings.
    crate::store::transaction::run(&path.with_extension("lock"), Duration::from_secs(30), change)
}

fn update(path: &Path, session: &str, additions: Vec<Association>) -> Result<Vec<Association>> {
    if session.is_empty() { bail!("A session is required to associate a pull request"); }
    transaction(path, || {
        let mut all: Associations = crate::store::read_json(path)?.unwrap_or_default();
        let changed = merge(&mut all, session, additions)?;
        if changed { crate::store::write_json(path, &all)?; }
        Ok(all.get(session).into_iter().flat_map(|entries| entries.values().cloned()).collect())
    })
}

fn merge(all: &mut Associations, session: &str, additions: Vec<Association>) -> Result<bool> {
    let saved = all.entry(session.to_string()).or_default();
    let mut changed = false;
    for mut entry in additions {
        entry.url = identity(&entry.url)?;
        if entry.url.rsplit('/').next().and_then(|n| n.parse::<u64>().ok()) != Some(entry.number) {
            bail!("Pull request number does not match its URL");
        }
        // Keep the original transport locator: pipeline migration may name the
        // project root whereas the panel already knows the live workspace.
        match saved.entry(entry.url.clone()) {
            std::collections::btree_map::Entry::Vacant(slot) => { slot.insert(entry); changed = true; }
            std::collections::btree_map::Entry::Occupied(mut slot) => {
                // The runtime can resolve a previously unavailable or moved
                // repository. Refresh only a locator within the same workspace.
                if matches!((&slot.get().scope, &entry.scope),
                    (Scope::Cloud { workspace: old, repo: old_repo }, Scope::Cloud { workspace, repo })
                    if old == workspace && !repo.is_empty() && old_repo != repo) {
                    slot.get_mut().scope = entry.scope;
                    changed = true;
                }
            }
        }
    }
    Ok(changed)
}

pub fn record_local(session: &str, cwd: &Path, url: &str, head: &str) -> Result<()> {
    let url = identity(url)?;
    let number = url.rsplit('/').next().unwrap().parse()?;
    update(&crate::store::root()?.join("session-pr-associations.json"), session, vec![Association {
        url, number, head: head.into(), scope: Scope::Local { cwd: cwd.to_string_lossy().into_owned() }, linked: false,
    }])?;
    Ok(())
}

/// The normalized journal is written even with no panel mounted. Recover only
/// successful creation tool calls, never PR links in prose, reviews or reads.
/// Reading it here also repairs associations after a crash or an older version.
type CreationCalls = BTreeSet<(String, Option<String>, String)>;

fn observe(calls: &mut CreationCalls, event: crate::events::AgentEvent, session: &str, cwd: &str) -> Option<Association> {
    use crate::events::{Payload, ToolType};
    if event.session_id != session { return None; }
    let key = |id: &str| (event.tab_id.clone(), event.subagent.as_ref().map(|s| s.id.clone()), id.to_string());
    match event.payload {
        Payload::ToolCallStarted { call_id, tool_type, input, .. } => {
            // Harnesses can reuse call ids after an interrupted conversation.
            calls.remove(&key(&call_id));
            let command = input.get("cmd").or_else(|| input.get("command")).and_then(|v| v.as_str()).unwrap_or_default();
            if tool_type == ToolType::Shell && creates_pr(command) { calls.insert(key(&call_id)); }
        }
        Payload::ToolCallCompleted { call_id, result } if calls.remove(&key(&call_id)) && !result.is_error && result.exit_code.is_none_or(|code| code == 0) => {
            // Only a successful creation's standalone URL is ownership evidence.
            let urls: BTreeSet<_> = result.text.lines().filter_map(|line| identity(line.trim()).ok()).collect();
            if urls.len() == 1 {
                let url = urls.into_iter().next().unwrap();
                return Some(Association { number: url.rsplit('/').next().unwrap().parse().unwrap(), url, head: String::new(), scope: Scope::Local { cwd: cwd.into() }, linked: false });
            }
        }
        _ => {}
    }
    None
}

#[cfg(test)]
fn creation_evidence(events: impl IntoIterator<Item = crate::events::AgentEvent>, session: &str, cwd: &str) -> Vec<Association> {
    let mut calls = CreationCalls::new();
    events.into_iter().filter_map(|event| observe(&mut calls, event, session, cwd)).collect()
}

/// Recognize a shell command, not quoted documentation or an echo of one.
/// Once the executable and subcommand are known, its arguments (including
/// body heredocs and substitutions) cannot change that creation evidence.
fn creates_pr(command: &str) -> bool {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    let matches = |words: &[String]| words.len() >= 3 && words[0].rsplit('/').next() == Some("gh") && words[1] == "pr" && words[2] == "create";
    let mut chars = command.chars().chain(std::iter::once(';')).peekable();
    while let Some(c) = chars.next() {
        if escaped { word.push(c); escaped = false; continue; }
        if c == '\\' && quote != Some('\'') { escaped = true; continue; }
        if let Some(q) = quote {
            if c == q { quote = None; } else { word.push(c); }
            continue;
        }
        if c == '\'' || c == '"' { quote = Some(c); continue; }
        // Do not mistake a heredoc's contents or nested shell text for a
        // top-level command. A real gh prefix has already returned above.
        if c == '`' || (c == '$' && chars.peek() == Some(&'(')) || (c == '<' && chars.peek() == Some(&'<')) { return false; }
        if c == '#' && word.is_empty() {
            for next in chars.by_ref() { if next == '\n' { break; } }
            words.clear();
            continue;
        }
        if c.is_whitespace() || matches!(c, ';' | '&' | '|') {
            if !word.is_empty() { words.push(std::mem::take(&mut word)); }
            if matches(&words) { return true; }
            if matches!(c, ';' | '&' | '|' | '\n') {
                words.clear();
            }
        } else { word.push(c); }
    }
    false
}

/// Persist scan positions and in-flight creation calls, including across restarts.
/// Journals are append-only. A replacement/truncation starts a new stream while
/// previously recorded ownership survives journal pruning.
#[derive(Default, Serialize, Deserialize)]
struct JournalCursor {
    offset: u64,
    #[serde(default)]
    observed_len: u64,
    file_id: String,
    calls: CreationCalls,
}
type JournalIndex = BTreeMap<String, BTreeMap<String, JournalCursor>>;

fn file_id(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    { format!("{:?}", metadata.created().ok()) }
}

fn read_new_events(path: &Path, cursor: &mut JournalCursor, session: &str, cwd: &str, found: &mut Vec<Association>) -> Result<u64> {
    let metadata = std::fs::metadata(path)?;
    let id = file_id(&metadata);
    if cursor.file_id != id || cursor.offset > metadata.len() || cursor.observed_len > metadata.len() {
        *cursor = JournalCursor { file_id: id, ..Default::default() };
    }
    // Even a torn final record is read only once until more bytes arrive.
    if cursor.offset == metadata.len() || cursor.observed_len == metadata.len() { return Ok(0); }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(cursor.offset))?;
    // Bound the snapshot even while a writer keeps appending. Incomplete JSON
    // stays unconsumed; a complete last event survives a crash before its newline.
    let mut reader = BufReader::new(file.take(metadata.len() - cursor.offset));
    let mut line = Vec::new();
    let mut bytes = 0;
    loop {
        line.clear();
        let count = reader.read_until(b'\n', &mut line)?;
        bytes += count as u64;
        if count == 0 { break; }
        let terminated = line.last() == Some(&b'\n');
        let event = serde_json::from_slice(&line);
        if !terminated && event.is_err() { break; }
        cursor.offset += count as u64;
        if let Ok(event) = event {
            found.extend(observe(&mut cursor.calls, event, session, cwd));
        }
        if !terminated { break; }
    }
    cursor.observed_len = metadata.len();
    Ok(bytes)
}

/// One batch loads each small registry once. Only journal suffixes that have
/// arrived since the durable checkpoint are read; an unchanged refresh reads
/// zero transcript bytes. The first read backfills older app versions once.
fn refresh(
    root: &Path, sessions: &[String],
    load_cwds: impl FnOnce() -> Result<BTreeMap<String, String>>,
    load_pipelines: impl FnOnce() -> Result<Vec<crate::issue_pipeline::Pipeline>>,
    additions: BTreeMap<String, Vec<Association>>,
) -> Result<(BTreeMap<String, Vec<Association>>, u64)> {
    transaction(&root.join("session-pr-associations.json"), || refresh_locked(root, sessions, load_cwds, load_pipelines, additions))
}

fn refresh_locked(
    root: &Path, sessions: &[String],
    load_cwds: impl FnOnce() -> Result<BTreeMap<String, String>>,
    load_pipelines: impl FnOnce() -> Result<Vec<crate::issue_pipeline::Pipeline>>,
    additions: BTreeMap<String, Vec<Association>>,
) -> Result<(BTreeMap<String, Vec<Association>>, u64)> {
    let path = root.join("session-pr-associations.json");
    let index_path = root.join("session-pr-journal-index-v1.json");
    let mut all: Associations = crate::store::read_json(&path)?.unwrap_or_default();
    let local = sessions.iter().any(|session| !session.starts_with("cloud:"));
    let mut index: JournalIndex = if local { crate::store::read_json(&index_path)?.unwrap_or_default() } else { BTreeMap::new() };
    let before = serde_json::to_vec(&index)?;
    // As before, missing/unreadable session metadata only prevents journal
    // discovery. It must not hide ownership retained in the separate cache.
    let cwds = if local { load_cwds().unwrap_or_default() } else { BTreeMap::new() };
    let mut pipeline_rows: BTreeMap<String, Vec<Association>> = BTreeMap::new();
    if local {
        // Parse the pipelines file once per refresh, not once per session.
        let requested: BTreeSet<_> = sessions.iter().collect();
        for pipeline in load_pipelines()?.into_iter().filter(|pipeline| requested.contains(&pipeline.author.session_id)) {
            let urls = pipeline.pr.iter().map(|pr| pr.url.as_str()).chain(
                pipeline.events.iter().filter(|event| event.kind == "pullRequest").filter_map(|event| event.url.as_deref()),
            );
            for url in urls {
                let canonical = identity(url)?;
                let number = canonical.rsplit('/').next().unwrap().parse()?;
                pipeline_rows.entry(pipeline.author.session_id.clone()).or_default().push(Association {
                    url: canonical, number, head: pipeline.branch.clone(),
                    scope: Scope::Local { cwd: pipeline.project_path.clone() }, linked: false,
                });
            }
        }
    }
    let mut changed = false;
    let mut bytes = 0;
    for session in sessions.iter().collect::<BTreeSet<_>>() {
        if session.is_empty() { bail!("A session is required to associate a pull request"); }
        // Preserve the caller's live locator ahead of historical backfill,
        // matching the single-session API's original precedence.
        let mut found: Vec<_> = additions.get(session).into_iter().flatten().cloned().collect();
        if !session.starts_with("cloud:") {
            if let Some(cwd) = cwds.get(session) {
                let dir = root.join("sessions").join(session);
                if dir.is_dir() {
                    for entry in std::fs::read_dir(dir)? {
                        let entry = entry?;
                        let path = entry.path();
                        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") { continue; }
                        let cursor = index.entry(session.clone()).or_default().entry(entry.file_name().to_string_lossy().into_owned()).or_default();
                        bytes += read_new_events(&path, cursor, session, cwd, &mut found)?;
                    }
                }
            }
            found.extend(pipeline_rows.remove(session).unwrap_or_default());
        }
        changed |= merge(&mut all, session, found)?;
    }
    // Write identities before advancing checkpoints: a crash can repeat evidence,
    // but can never skip a creation that has not yet been saved.
    if changed { crate::store::write_json(&path, &all)?; }
    if serde_json::to_vec(&index)? != before { crate::store::write_json(&index_path, &index)?; }
    let rows = sessions.iter().map(|id| (id.clone(), all.get(id).into_iter().flat_map(|entries| entries.values().cloned()).collect())).collect();
    Ok((rows, bytes))
}

fn load_cwds() -> Result<BTreeMap<String, String>> {
    Ok(crate::store::index::load()?.into_iter().map(|session| (session.id, session.cwd)).collect())
}

pub fn for_sessions(sessions: &[String]) -> Result<BTreeMap<String, Vec<Association>>> {
    refresh(&crate::store::root()?, sessions, load_cwds, crate::issue_pipeline::store::list, BTreeMap::new()).map(|(rows, _)| rows)
}

pub fn for_session(session: &str, additions: Vec<Association>) -> Result<Vec<Association>> {
    let (mut rows, _) = refresh(&crate::store::root()?, &[session.into()], load_cwds, crate::issue_pipeline::store::list, BTreeMap::from([(session.into(), additions)]))?;
    Ok(rows.remove(session).unwrap_or_default())
}

/// The sessions, other than `session`, that already show each of `urls`: by
/// a link or by having opened it. Sessions that no longer exist are left out
/// (`live`), so a deleted session does not hold a pull request forever.
fn others_with(all: &Associations, session: &str, urls: &BTreeSet<String>, live: &dyn Fn(&str) -> bool) -> BTreeMap<String, Vec<String>> {
    let mut found: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (other, entries) in all {
        if other == session || !live(other) { continue; }
        for url in entries.keys().filter(|url| urls.contains(*url)) {
            found.entry(url.clone()).or_default().push(other.clone());
        }
    }
    found
}

fn link_in(path: &Path, session: &str, mut entry: Association, live: &dyn Fn(&str) -> bool) -> Result<Vec<Association>> {
    if session.is_empty() { bail!("A session is required to link a pull request"); }
    entry.url = identity(&entry.url)?;
    if entry.url.rsplit('/').next().and_then(|n| n.parse::<u64>().ok()) != Some(entry.number) {
        bail!("Pull request number does not match its URL");
    }
    if !matches!(entry.scope, Scope::Local { .. }) { bail!("Only a session on this Mac can link a pull request"); }
    entry.linked = true;
    transaction(path, || {
        let mut all: Associations = crate::store::read_json(path)?.unwrap_or_default();
        // One session shows a pull request at a time; the dialog says which
        // rows are taken, and this refuses a race between two windows.
        if others_with(&all, session, &BTreeSet::from([entry.url.clone()]), live).contains_key(&entry.url) {
            bail!("#{} is linked to another session", entry.number);
        }
        let saved = all.entry(session.to_string()).or_default();
        // Already this session's own (it opened it): nothing to add.
        if !saved.contains_key(&entry.url) {
            saved.insert(entry.url.clone(), entry);
            crate::store::write_json(path, &all)?;
        }
        Ok(all.get(session).into_iter().flat_map(|entries| entries.values().cloned()).collect())
    })
}

fn unlink_in(path: &Path, session: &str, url: &str) -> Result<Vec<Association>> {
    let url = identity(url)?;
    transaction(path, || {
        let mut all: Associations = crate::store::read_json(path)?.unwrap_or_default();
        let Some(entries) = all.get_mut(session) else { return Ok(vec![]) };
        match entries.get(&url) {
            None => {}
            Some(entry) if !entry.linked => bail!("This session opened #{}; only a linked pull request can be unlinked", entry.number),
            Some(_) => {
                entries.remove(&url);
                if entries.is_empty() { all.remove(session); }
                crate::store::write_json(path, &all)?;
            }
        }
        Ok(all.get(session).into_iter().flat_map(|entries| entries.values().cloned()).collect())
    })
}

fn live_sessions() -> Result<BTreeSet<String>> {
    Ok(crate::store::index::load()?.into_iter().map(|session| session.id).collect())
}

fn registry() -> Result<std::path::PathBuf> {
    Ok(crate::store::root()?.join("session-pr-associations.json"))
}

/// Show `entry` in `session`'s pull request section, whichever branch it is on.
pub fn link(session: &str, entry: Association) -> Result<Vec<Association>> {
    let live = live_sessions()?;
    link_in(&registry()?, session, entry, &|id| live.contains(id))
}

/// Remove a link made with [`link`]; a PR the session opened stays.
pub fn unlink(session: &str, url: &str) -> Result<Vec<Association>> {
    unlink_in(&registry()?, session, url)
}

/// For each of `urls`, the other existing sessions that show it.
pub fn linked_elsewhere(session: &str, urls: &[String]) -> Result<BTreeMap<String, Vec<String>>> {
    let path = registry()?;
    let urls: BTreeSet<String> = urls.iter().filter_map(|url| identity(url).ok()).collect();
    let live = live_sessions()?;
    transaction(&path, || {
        let all: Associations = crate::store::read_json(&path)?.unwrap_or_default();
        Ok(others_with(&all, session, &urls, &|id| live.contains(id)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(repo: &str, number: u64, head: &str) -> Association {
        Association { url: format!("https://github.com/acme/{repo}/pull/{number}"), number, head: head.into(), scope: Scope::Local { cwd: "/fixture".into() }, linked: false }
    }

    fn journal_event(session: &str, payload: serde_json::Value) -> String {
        serde_json::json!({ "id": "event", "sessionId": session, "tabId": "tab", "harness": "codex", "seq": 1, "ts": "", "payload": payload }).to_string()
    }
    fn start(session: &str) -> String {
        journal_event(session, serde_json::json!({ "type": "tool_call_started", "callId": "create", "name": "exec_command", "toolType": "shell", "input": { "cmd": "gh pr create" } }))
    }
    fn completed(session: &str, number: u64) -> String {
        journal_event(session, serde_json::json!({ "type": "tool_call_completed", "callId": "create", "result": { "text": format!("https://github.com/acme/api/pull/{number}"), "isError": false, "exitCode": 0 } }))
    }

    #[test]
    fn refresh_holds_an_os_transaction_lock_until_registry_and_checkpoint_are_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-pr-associations.json");
        let folder = dir.path().join("sessions/one");
        std::fs::create_dir_all(&folder).unwrap();
        crate::store::append_line(&folder.join("tab.jsonl"), &start("one")).unwrap();
        let check_lock = || {
            // An independent descriptor uses the same OS exclusion as another
            // desktop/runtime process; a process-local mutex cannot satisfy it.
            let competing = File::open(path.with_extension("lock")).unwrap();
            assert!(matches!(competing.try_lock(), Err(std::fs::TryLockError::WouldBlock)));
        };
        refresh(dir.path(), &["one".into()],
            || { check_lock(); Ok(BTreeMap::from([("one".into(), "/fixture".into())])) },
            || { check_lock(); Ok(vec![]) },
            BTreeMap::from([("one".into(), vec![entry("api", 1, "first")])])).unwrap();
        assert!(dir.path().join("session-pr-journal-index-v1.json").is_file());
        // Explicit recordings use the same transaction and preserve the batch.
        update(&path, "two", vec![entry("api", 2, "second")]).unwrap();
        let saved: Associations = crate::store::read_json(&path).unwrap().unwrap();
        assert_eq!(saved["one"].len(), 1);
        assert_eq!(saved["two"].len(), 1);
    }

    #[test]
    fn refresh_reads_no_old_transcripts_and_parses_pipelines_once_for_the_batch() {
        use std::cell::Cell;
        let dir = tempfile::tempdir().unwrap();
        let sessions = vec!["one".to_string(), "two".to_string()];
        let pipeline_reads = Cell::new(0);
        let read = || refresh(dir.path(), &sessions,
            || Ok(sessions.iter().map(|id| (id.clone(), "/fixture".into())).collect()),
            || { pipeline_reads.set(pipeline_reads.get() + 1); Ok(vec![]) }, BTreeMap::new()).unwrap();
        for session in &sessions {
            let folder = dir.path().join("sessions").join(session);
            std::fs::create_dir_all(&folder).unwrap();
            crate::store::append_line(&folder.join("tab.jsonl"), &start(session)).unwrap();
        }
        let (_, first_bytes) = read();
        assert!(first_bytes > 0);
        assert_eq!(pipeline_reads.get(), 1);
        // Every call reloads checkpoints from disk, just like reopening the app.
        let (_, bytes) = read();
        assert_eq!(bytes, 0, "refresh must not reopen or parse unchanged journals");
        assert_eq!(pipeline_reads.get(), 2, "one pipeline read per batch, not per session");
        let line = completed("one", 12);
        let journal = dir.path().join("sessions/one/tab.jsonl");
        crate::store::append_line(&journal, &line).unwrap();
        let (rows, bytes) = read();
        assert_eq!(bytes, line.len() as u64 + 1, "only new events are read");
        assert_eq!(rows["one"][0].number, 12, "creation calls survive across refreshes/restarts");
        assert!(rows["two"].is_empty());
        assert_eq!(read().1, 0);
        std::fs::remove_file(journal).unwrap();
        assert_eq!(read().0["one"][0].number, 12, "ownership survives journal pruning");
    }

    #[test]
    fn partial_records_and_replaced_journals_do_not_lose_creation_evidence() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join("tab.jsonl");
        crate::store::append_line(&journal, &start("one")).unwrap();
        let mut cursor = JournalCursor::default();
        let mut found = vec![];
        read_new_events(&journal, &mut cursor, "one", "/fixture", &mut found).unwrap();
        let offset = cursor.offset;
        let completion = completed("one", 2);
        let mut writer = std::fs::OpenOptions::new().append(true).open(&journal).unwrap();
        let split = completion.len() / 2;
        writer.write_all(&completion.as_bytes()[..split]).unwrap();
        read_new_events(&journal, &mut cursor, "one", "/fixture", &mut found).unwrap();
        assert_eq!(cursor.offset, offset);
        assert!(found.is_empty());
        assert_eq!(read_new_events(&journal, &mut cursor, "one", "/fixture", &mut found).unwrap(), 0);
        writer.write_all(&completion.as_bytes()[split..]).unwrap();
        writer.write_all(b"\n").unwrap();
        read_new_events(&journal, &mut cursor, "one", "/fixture", &mut found).unwrap();
        assert_eq!(found[0].number, 2);
        crate::store::write_atomic(&journal, format!("{}\n{}", start("one"), completed("one", 3)).as_bytes()).unwrap();
        read_new_events(&journal, &mut cursor, "one", "/fixture", &mut found).unwrap();
        assert_eq!(found[1].number, 3);
        assert_eq!(read_new_events(&journal, &mut cursor, "one", "/fixture", &mut found).unwrap(), 0);
    }

    #[test]
    fn a_reused_call_id_cannot_turn_a_read_into_creation_evidence() {
        let events = [start("one"), journal_event("one", serde_json::json!({ "type": "tool_call_started", "callId": "create", "name": "exec_command", "toolType": "shell", "input": { "cmd": "gh pr view 2" } })), completed("one", 2)];
        assert!(creation_evidence(events.iter().map(|line| serde_json::from_str(line).unwrap()), "one", "/fixture").is_empty());
    }

    #[test]
    fn a_cloud_only_batch_uses_the_cache_without_local_journals_or_pipelines() {
        let dir = tempfile::tempdir().unwrap();
        let id = "cloud:org:workspace:session".to_string();
        update(&dir.path().join("session-pr-associations.json"), &id, vec![entry("api", 2, "feature")]).unwrap();
        std::fs::write(dir.path().join("session-pr-journal-index-v1.json"), "unreadable local checkpoints").unwrap();
        let (rows, bytes) = refresh(dir.path(), std::slice::from_ref(&id), || panic!("no local sessions"), || panic!("no local pipelines"), BTreeMap::new()).unwrap();
        assert_eq!(rows[&id][0].number, 2);
        assert_eq!(bytes, 0);
    }

    #[test]
    fn cached_ownership_survives_an_unreadable_session_index() {
        let dir = tempfile::tempdir().unwrap();
        update(&dir.path().join("session-pr-associations.json"), "one", vec![entry("api", 2, "feature")]).unwrap();
        let (rows, bytes) = refresh(dir.path(), &["one".into()], || Err(anyhow::anyhow!("unreadable index")), || Ok(vec![]), BTreeMap::new()).unwrap();
        assert_eq!(rows["one"][0].number, 2);
        assert_eq!(bytes, 0);
    }

    #[test]
    fn an_explicit_live_locator_takes_precedence_over_journal_backfill() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("sessions/one");
        std::fs::create_dir_all(&folder).unwrap();
        crate::store::append_line(&folder.join("tab.jsonl"), &start("one")).unwrap();
        crate::store::append_line(&folder.join("tab.jsonl"), &completed("one", 2)).unwrap();
        let mut reference = entry("api", 2, "live-branch");
        reference.scope = Scope::Local { cwd: "/live-worktree".into() };
        let (rows, _) = refresh(dir.path(), &["one".into()], || Ok(BTreeMap::from([("one".into(), "/old-worktree".into())])), || Ok(vec![]), BTreeMap::from([("one".into(), vec![reference])])).unwrap();
        assert_eq!(rows["one"][0].head, "live-branch");
        assert!(matches!(&rows["one"][0].scope, Scope::Local { cwd } if cwd == "/live-worktree"));
    }

    #[test]
    fn cloud_cache_refreshes_its_resolved_repository_locator() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("associations.json");
        let session = "cloud:org:workspace:author";
        let mut reference = entry("a", 1, "topic");
        reference.scope = Scope::Cloud { workspace: "cloud:org:workspace".into(), repo: String::new() };
        update(&path, session, vec![reference.clone()]).unwrap();
        reference.scope = Scope::Cloud { workspace: "cloud:org:workspace".into(), repo: "libs/a".into() };
        update(&path, session, vec![reference]).unwrap();
        let saved = update(&path, session, vec![]).unwrap();
        assert!(matches!(&saved[0].scope, Scope::Cloud { repo, .. } if repo == "libs/a"));
    }

    #[test]
    fn recovers_creation_from_durable_tools_without_branch_or_panel_state() {
        use crate::events::{AgentEvent, Payload, ToolResult, ToolType};
        let event = |session: &str, payload| AgentEvent { id: "event".into(), session_id: session.into(), tab_id: "tab".into(), harness: "codex".into(), seq: 1, ts: String::new(), message_ts: None, subagent: None, payload };
        let call = |id: &str, command: &str| Payload::ToolCallStarted { call_id: id.into(), name: "exec_command".into(), tool_type: ToolType::Shell, input: serde_json::json!({ "cmd": command }), title: None };
        let result = |id: &str, text: &str, is_error| Payload::ToolCallCompleted { call_id: id.into(), result: ToolResult { text: text.into(), is_error, exit_code: Some(if is_error { 1 } else { 0 }), ..Default::default() } };
        let url = "https://github.com/acme/widgets/pull/2";
        let events = vec![
            event("author", call("create", "cd /fixture && gh pr create --head followup --body-file - <<'EOF'\nUse `code`.\nEOF")),
            event("author", result("create", url, false)),
            event("author", call("read", "gh pr view 99")),
            event("author", result("read", "https://github.com/acme/widgets/pull/99", false)),
            event("author", call("failed", "gh pr create")),
            event("author", result("failed", "https://github.com/acme/widgets/pull/98", true)),
            event("other", call("other", "gh pr create")),
            event("other", result("other", "https://github.com/acme/widgets/pull/97", false)),
            event("author", Payload::AssistantText { block: None, text: "Review https://github.com/acme/widgets/pull/96".into() }),
        ];
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join("tab.jsonl");
        for e in &events { crate::store::append_line(&journal, &serde_json::to_string(e).unwrap()).unwrap(); }
        let recovered = creation_evidence(crate::store::read_lines::<AgentEvent>(&journal).unwrap(), "author", "/different-checkout");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].url, url);
        let registry = dir.path().join("associations.json");
        update(&registry, "author", recovered).unwrap();
        std::fs::remove_file(journal).unwrap();
        assert_eq!(update(&registry, "author", vec![]).unwrap()[0].url, url);
        assert!(update(&registry, "other", vec![]).unwrap().is_empty());
    }

    #[test]
    fn creation_commands_are_not_quoted_mentions_or_read_commands() {
        for command in ["gh pr create --title 'a; gh pr view 3'", "cd /repo && gh pr create", "git switch followup\ngh pr create --draft",
            "gh pr create --body-file - <<'EOF'\nUse `code` and $(literal).\nEOF",
            "gh pr create --body 'Use `code` and $(literal) and << in Markdown'",
            "gh pr create --body \"$(cat /tmp/body)\"",
            "gh pr create --body `cat /tmp/body`"] {
            assert!(creates_pr(command), "{command}");
        }
        for command in ["echo 'gh pr create'", "printf '%s' 'example; gh pr create'", "gh pr view 3", "cat <<EOF\ngh pr create\nEOF"] {
            assert!(!creates_pr(command), "{command}");
        }
    }

    #[test]
    fn retains_followups_across_reloads_without_crossing_sessions_or_repositories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prs.json");
        update(&path, "one", vec![entry("a", 1, "initial"), entry("a", 2, "initial")]).unwrap();
        update(&path, "one", vec![entry("a", 3, "followup"), entry("b", 1, "followup")]).unwrap();
        update(&path, "two", vec![entry("c", 1, "initial")]).unwrap();
        let mut duplicate = entry("a", 1, "initial");
        duplicate.url = "https://github.com/ACME/A/pull/1/".into();
        assert_eq!(update(&path, "one", vec![duplicate]).unwrap().len(), 4);
        assert_eq!(update(&path, "one", vec![]).unwrap().len(), 4);
        assert_eq!(update(&path, "two", vec![]).unwrap().len(), 1);
    }

    #[test]
    fn concurrent_additions_are_unioned_and_invalid_updates_do_not_replace_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prs.json");
        std::thread::scope(|s| {
            for number in 1..=8 {
                let path = &path;
                s.spawn(move || update(path, "one", vec![entry("a", number, "topic")]).unwrap());
            }
        });
        assert_eq!(update(&path, "one", vec![]).unwrap().len(), 8);
        let mut invalid = entry("a", 9, "topic");
        invalid.number = 10;
        assert!(update(&path, "one", vec![invalid]).is_err());
        assert_eq!(update(&path, "one", vec![]).unwrap().len(), 8);
        for url in ["file:///a/b/pull/1", "https://github.com/a/b/issues/1", "https://user:secret@github.com/a/b/pull/1"] {
            assert!(identity(url).is_err());
        }
    }

    fn linked(number: u64, head: &str) -> Association {
        Association { url: format!("https://github.com/Acme/API/pull/{number}"), number, head: head.into(), scope: Scope::Local { cwd: "/fixture".into() }, linked: false }
    }

    #[test]
    fn a_linked_pull_request_on_another_branch_is_stored_and_survives_reloading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-pr-associations.json");
        let rows = link_in(&path, "one", linked(788, "raccoon/approval-cards-diff"), &|_| true).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].url, "https://github.com/acme/api/pull/788", "stored under its canonical identity");
        assert!(rows[0].linked);
        assert_eq!(rows[0].head, "raccoon/approval-cards-diff");
        // A restart reads the same file: the link is on disk, flagged as a link.
        let saved: Associations = crate::store::read_json(&path).unwrap().unwrap();
        assert!(saved["one"]["https://github.com/acme/api/pull/788"].linked);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"linked\": true") || text.contains("\"linked\":true"), "{text}");
        // And the ordinary session read (journals, pipelines) keeps it.
        let (rows, _) = refresh(dir.path(), &["one".into()], || Ok(BTreeMap::new()), || Ok(vec![]), BTreeMap::new()).unwrap();
        assert_eq!(rows["one"].len(), 1);
        assert!(rows["one"][0].linked);
    }

    #[test]
    fn a_pull_request_shown_by_another_existing_session_cannot_be_linked_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-pr-associations.json");
        update(&path, "creator", vec![entry("api", 783, "raccoon/session-overview")]).unwrap();
        let error = link_in(&path, "one", linked(783, "raccoon/session-overview"), &|_| true).unwrap_err();
        assert_eq!(error.to_string(), "#783 is linked to another session");
        let all: Associations = crate::store::read_json(&path).unwrap().unwrap();
        assert!(!all.contains_key("one"));
        assert_eq!(others_with(&all, "one", &BTreeSet::from(["https://github.com/acme/api/pull/783".to_string()]), &|_| true)
            ["https://github.com/acme/api/pull/783"], vec!["creator".to_string()]);
        // The creating session itself is not "another session".
        assert!(others_with(&all, "creator", &BTreeSet::from(["https://github.com/acme/api/pull/783".to_string()]), &|_| true).is_empty());
        // A session that was deleted no longer holds it.
        assert!(link_in(&path, "one", linked(783, "raccoon/session-overview"), &|id| id != "creator").is_ok());
    }

    #[test]
    fn only_a_link_can_be_unlinked_and_linking_an_own_pull_request_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-pr-associations.json");
        update(&path, "one", vec![entry("api", 5, "mine")]).unwrap();
        let rows = link_in(&path, "one", linked(5, "mine"), &|_| true).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].linked, "the session opened it; it stays its own");
        assert!(unlink_in(&path, "one", "https://github.com/acme/api/pull/5").unwrap_err().to_string().contains("only a linked pull request can be unlinked"));
        link_in(&path, "one", linked(9, "theirs"), &|_| true).unwrap();
        let rows = unlink_in(&path, "one", "https://github.com/ACME/api/pull/9").unwrap();
        assert_eq!(rows.iter().map(|row| row.number).collect::<Vec<_>>(), vec![5]);
        // Unlinking again, or an unknown session, is not an error.
        assert_eq!(unlink_in(&path, "one", "https://github.com/acme/api/pull/9").unwrap().len(), 1);
        assert!(unlink_in(&path, "nobody", "https://github.com/acme/api/pull/9").unwrap().is_empty());
        // Once unlinked, another session may link it.
        assert!(link_in(&path, "two", linked(9, "theirs"), &|_| true).is_ok());
    }

    #[test]
    fn a_link_needs_a_local_session_and_a_matching_pull_request_url() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-pr-associations.json");
        let mut cloud = linked(1, "x");
        cloud.scope = Scope::Cloud { workspace: "w".into(), repo: "acme/api".into() };
        assert!(link_in(&path, "one", cloud, &|_| true).is_err());
        let mut wrong = linked(1, "x");
        wrong.number = 2;
        assert!(link_in(&path, "one", wrong, &|_| true).is_err());
        assert!(link_in(&path, "", linked(1, "x"), &|_| true).is_err());
        assert!(!path.exists(), "nothing written for a refused link");
    }

    #[test]
    fn associations_saved_before_links_existed_still_read_as_not_linked() {
        let old = r#"{"url":"https://github.com/acme/api/pull/3","number":3,"head":"h","scope":{"kind":"local","cwd":"/x"}}"#;
        let entry: Association = serde_json::from_str(old).unwrap();
        assert!(!entry.linked);
        assert!(!serde_json::to_string(&entry).unwrap().contains("linked"), "unchanged on disk for older readers");
    }
}
