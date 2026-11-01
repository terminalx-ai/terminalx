//! The archive's rules (#718). The pure decision is read against made-up
//! facts; the sweep, the shared archive and the worktree and pipeline checks
//! against a disposable home, real git repositories and a real runtime.
use std::collections::{HashMap, HashSet};

use chrono::{Duration, SecondsFormat};
use serde_json::{json, Value};

use super::*;
use crate::sink::BroadcastSink;
use crate::store::{self, index::TabStatus};

fn at(time: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(time).unwrap().with_timezone(&Utc)
}

/// When every made-up session is looked at.
fn now() -> DateTime<Utc> {
    at("2026-11-01T12:00:00Z")
}

fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A session created two months before `now`, with one idle tab and, when
/// given, its last message that many days before `now`.
fn session(id: &str, last_message_days_ago: Option<i64>, now: DateTime<Utc>) -> SessionEntry {
    let created = stamp(now - Duration::days(60));
    let mut value = json!({
        "id": id, "projectPath": "/work", "cwd": "/work", "title": id, "created": created, "modified": created,
        "tabs": [{ "id": format!("{id}-tab"), "harness": "claude", "created": created }],
    });
    if let Some(days) = last_message_days_ago {
        value["lastMessageAt"] = json!(stamp(now - Duration::days(days)));
    }
    serde_json::from_value(value).unwrap()
}

/// What only a runtime, git or the pipelines would know, made up.
#[derive(Default)]
struct Facts {
    shown: HashSet<String>,
    busy: HashMap<String, Kept>,
    in_pipelines: HashSet<String>,
    local_work: HashSet<String>,
    logs_written: HashMap<String, DateTime<Utc>>,
}

impl Facts {
    fn kept(&self, session: &SessionEntry, days: i64) -> Option<Kept> {
        let busy = |session: &SessionEntry| self.busy.get(&session.id).copied();
        let local_work = |session: &SessionEntry| self.local_work.contains(&session.id);
        let logs_written = |session: &SessionEntry| self.logs_written.get(&session.id).copied();
        kept(session, &Sweep {
            limit: Duration::days(days),
            now: now(),
            shown: &self.shown,
            busy: &busy,
            in_pipelines: &self.in_pipelines,
            local_work: &local_work,
            logs_written: &logs_written,
        })
    }
}

#[test]
fn a_session_quiet_past_the_limit_is_let_go_and_each_exclusion_keeps_one() {
    let mut facts = Facts::default();
    let quiet = session("quiet", Some(8), now());
    assert_eq!(facts.kept(&quiet, 7), None, "nothing keeps it");

    let mut pinned = session("pinned", Some(30), now());
    pinned.pinned = true;
    assert_eq!(facts.kept(&pinned, 7), Some(Kept::Pinned));

    facts.shown.insert("shown".into());
    assert_eq!(facts.kept(&session("shown", Some(30), now()), 7), Some(Kept::Shown));

    // As the index has them, and as the runtime knows them.
    for (status, why) in [(TabStatus::InProgress, Kept::Working), (TabStatus::Waiting, Kept::WaitingForYou), (TabStatus::Completed, Kept::Unread)] {
        let mut stored = session("stored", Some(30), now());
        stored.tabs[0].status = status;
        assert_eq!(facts.kept(&stored, 7), Some(why), "{status:?}");
    }
    for why in [Kept::Working, Kept::WaitingForYou, Kept::Queued, Kept::Unread] {
        facts.busy.insert("live".into(), why);
        assert_eq!(facts.kept(&session("live", Some(30), now()), 7), Some(why));
    }

    facts.local_work.insert("dirty".into());
    assert_eq!(facts.kept(&session("dirty", Some(30), now()), 7), Some(Kept::LocalWork));

    facts.in_pipelines.insert("in-review".into());
    assert_eq!(facts.kept(&session("in-review", Some(30), now()), 7), Some(Kept::PipelineOpen));

    // Recent: and what keeps a recent session is never even asked.
    assert_eq!(facts.kept(&session("dirty", Some(2), now()), 7), Some(Kept::Recent));
}

#[test]
fn idle_counts_from_the_last_message_in_any_tab_or_the_last_return_from_the_archive_not_from_creation() {
    let facts = Facts::default();
    // Created two months ago, written in yesterday.
    let busy_lately = session("lately", Some(1), now());
    assert_eq!(facts.kept(&busy_lately, 7), Some(Kept::Recent));
    assert_eq!(facts.kept(&busy_lately, 1), None, "a day's limit is a day");

    // Its last message a month ago, but brought back from the archive two days ago.
    let mut brought_back = session("back", Some(30), now());
    brought_back.archive.unarchived_at = Some(stamp(now() - Duration::days(2)));
    assert_eq!(facts.kept(&brought_back, 7), Some(Kept::Recent));
    assert_eq!(facts.kept(&brought_back, 1), None);

    // No message ever timed (written before #600): when its logs were last written, else when it was made.
    let mut facts = Facts::default();
    let untimed = session("untimed", None, now());
    assert_eq!(last_active(&untimed, || None), Some(now() - Duration::days(60)));
    assert_eq!(facts.kept(&untimed, 30), None);
    facts.logs_written.insert("untimed".into(), now() - Duration::days(3));
    assert_eq!(facts.kept(&untimed, 7), Some(Kept::Recent));
    // A time that cannot be read is not idle.
    let mut unreadable = session("unreadable", None, now());
    unreadable.created = "yesterday".into();
    assert_eq!(last_active(&unreadable, || None), None);
    assert_eq!(Facts::default().kept(&unreadable, 1), Some(Kept::Recent));
}

/// The sweep reads the index, archives what nothing keeps, and tells the
/// windows; the archive is the idle sweep's, and changes nothing the reader
/// did, nor when the session was last touched.
#[test]
fn the_sweep_archives_what_nothing_keeps_and_tells_the_windows() {
    let _home = store::temp_home();
    let now = Utc::now();
    let quiet = session("quiet", Some(10), now);
    let recent = session("recent", Some(2), now);
    let mut pinned = session("pinned", Some(40), now);
    pinned.pinned = true;
    let mut unread = session("unread", Some(40), now);
    unread.tabs[0].status = TabStatus::Completed;
    let shown_one = session("shown", Some(40), now);
    let mut already = session("already", Some(40), now);
    already.archived = true;
    index::save(&[quiet.clone(), recent, pinned, unread, shown_one, already]).unwrap();

    let sink = BroadcastSink::new(16);
    let mut heard = sink.subscribe();
    let shown: HashSet<String> = ["shown".to_string()].into();
    let none = HashSet::new();
    let archived = sweep(&sink, &Sweep {
        limit: Duration::days(7),
        now,
        shown: &shown,
        busy: &|_| None,
        in_pipelines: &none,
        local_work: &|_| false,
        logs_written: &|_| None,
    })
    .unwrap();
    assert_eq!(archived.iter().map(|session| session.id.as_str()).collect::<Vec<_>>(), ["quiet"]);

    let event = heard.try_recv().unwrap();
    assert_eq!(&*event.event, "session_updated");
    let told: SessionEntry = serde_json::from_str(&event.payload).unwrap();
    assert!(told.archived && told.archive.auto_archived);
    assert_eq!(crate::store::message_activity::last_message_at(&told), crate::store::message_activity::last_message_at(&quiet), "with its message time");
    assert!(heard.try_recv().is_err(), "nothing else changed");

    let stored = index::get("quiet").unwrap();
    assert!(stored.archived && stored.archive.auto_archived);
    assert_eq!(stored.modified, quiet.modified, "archiving by itself is not activity");
    let archived: Vec<String> = index::load().unwrap().into_iter().filter(|session| session.archived).map(|session| session.id).collect();
    assert_eq!(archived, ["quiet", "already"]);
}

/// What the app's menus, the bulk bar and the CLI all run.
#[test]
fn several_sessions_are_archived_together_or_not_at_all_and_a_person_makes_a_swept_one_theirs() {
    let _home = store::temp_home();
    let now = Utc::now();
    let mut swept = session("swept", Some(10), now);
    swept.archived = true;
    swept.archive.auto_archived = true;
    index::save(&[session("one", Some(1), now), session("two", Some(1), now), swept]).unwrap();
    let sink = BroadcastSink::new(16);
    let mut heard = sink.subscribe();

    let refused = set_archived(&sink, &["one".into(), "missing".into()], true, By::Person).unwrap_err();
    assert!(refused.to_string().contains("missing"), "{refused:#}");
    assert!(!index::get("one").unwrap().archived, "nothing changed");

    let both = set_archived(&sink, &["one".into(), "two".into(), "one".into()], true, By::Person).unwrap();
    assert_eq!(both.iter().map(|session| (session.id.as_str(), session.archived, session.archive.auto_archived)).collect::<Vec<_>>(), [("one", true, false), ("two", true, false)]);
    let told: Vec<String> = std::iter::from_fn(|| heard.try_recv().ok()).map(|event| serde_json::from_str::<SessionEntry>(&event.payload).unwrap().id).collect();
    assert_eq!(told, ["one", "two"]);

    // Archived by the sweep, then by a person: set aside on purpose now.
    set_archived(&sink, &["swept".into()], true, By::Person).unwrap();
    assert!(!index::get("swept").unwrap().archive.auto_archived);

    let back = set_archived(&sink, &["two".into()], false, By::Person).unwrap();
    assert!(!back[0].archived);
    let unarchived = back[0].archive.unarchived_at.as_deref().map(at).unwrap();
    assert!(Utc::now() - unarchived < Duration::minutes(1));
}

/// Never is never, and the runtime's own sweep goes by the setting, the
/// tabs it runs and the pipelines on disk.
#[test]
fn the_runtime_sweep_follows_the_setting_and_never_archives_nothing() {
    let _home = store::temp_home();
    let now = Utc::now();
    index::save(&[session("old", Some(20), now), session("week", Some(5), now)]).unwrap();
    let sink = std::sync::Arc::new(BroadcastSink::new(16));
    let manager = crate::session::SessionManager::new(
        sink.clone(), std::sync::Arc::new(crate::sink::NoObserver),
        std::sync::Arc::new(crate::harness::host::Host::new()), std::sync::Arc::new(crate::pty::Terminals::new()),
        std::sync::Arc::new(Default::default()), std::sync::Arc::new(Default::default()), crate::hooks::prepare_control().unwrap(),
    );
    let set = |days: u32| store::settings::save(&store::settings::Settings {
        conversations: store::settings::ConversationSettings { archive_idle_days: days },
        ..Default::default()
    }).unwrap();

    set(0);
    assert!(sweep_owned(&manager, sink.as_ref(), &HashSet::new()).unwrap().is_empty(), "Never");
    assert!(index::load().unwrap().iter().all(|session| !session.archived));

    set(14);
    let archived = sweep_owned(&manager, sink.as_ref(), &HashSet::new()).unwrap();
    assert_eq!(archived.iter().map(|session| session.id.as_str()).collect::<Vec<_>>(), ["old"]);
    set(3);
    let archived = sweep_owned(&manager, sink.as_ref(), &HashSet::new()).unwrap();
    assert_eq!(archived.iter().map(|session| session.id.as_str()).collect::<Vec<_>>(), ["week"]);
}

/// A message to an archived session brings it back, and tells the windows.
/// Every send ends here, in `publish`, as a message recorded with a time
/// newer than any before it (`message_activity::record`, whose own tests
/// show a message read again from a transcript is not).
#[test]
fn a_new_message_brings_an_archived_session_back() {
    let _home = store::temp_home();
    let mut archived = session("archived", Some(20), Utc::now());
    archived.archived = true;
    archived.archive.auto_archived = true;
    index::save(&[archived]).unwrap();
    let sink = std::sync::Arc::new(BroadcastSink::new(64));
    let manager = crate::session::SessionManager::new(
        sink.clone(), std::sync::Arc::new(crate::sink::NoObserver),
        std::sync::Arc::new(crate::harness::host::Host::new()), std::sync::Arc::new(crate::pty::Terminals::new()),
        std::sync::Arc::new(Default::default()), std::sync::Arc::new(Default::default()), crate::hooks::prepare_control().unwrap(),
    );
    let message = |text: &str| crate::events::Payload::UserMessage { author: None, text: text.into(), images: Vec::new(), baseline: None, queued: false, cwd: None };

    // The agent's own words are not a message to the session.
    manager.publish_external("archived", "archived-tab", crate::events::Payload::Status { text: "Stopped".into() }).unwrap();
    assert!(index::get("archived").unwrap().archived);

    let mut heard = sink.subscribe();
    manager.publish_external("archived", "archived-tab", message("carry on")).unwrap();
    let back = index::get("archived").unwrap();
    assert!(!back.archived && !back.archive.auto_archived && back.archive.unarchived_at.is_some());
    let told: Vec<SessionEntry> = std::iter::from_fn(|| heard.try_recv().ok())
        .filter(|event| &*event.event == "session_updated")
        .map(|event| serde_json::from_str(&event.payload).unwrap())
        .collect();
    assert!(told.last().is_some_and(|session| !session.archived), "the window hears it is back: {told:?}");
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn in_worktree(cwd: &Path) -> SessionEntry {
    let mut entry = session("worktree", Some(30), now());
    entry.cwd = cwd.to_string_lossy().into_owned();
    entry.worktree_name = Some("calm-ember-panda".into());
    entry
}

#[test]
fn a_worktree_with_changes_or_commits_nothing_else_has_keeps_its_session() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "work"]);
    std::fs::write(repo.join("a.txt"), "a").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    let entry = in_worktree(&repo);

    // No other branch, remote or tag has the commit.
    assert!(local_work(&entry), "unpushed");
    git(&repo, &["branch", "main"]);
    assert!(!local_work(&entry), "another branch has it");

    std::fs::write(repo.join("b.txt"), "new").unwrap();
    assert!(local_work(&entry), "untracked");
    git(&repo, &["add", "."]);
    assert!(local_work(&entry), "staged");
    git(&repo, &["commit", "-q", "-m", "second"]);
    assert!(local_work(&entry), "a commit only this branch has");
    git(&repo, &["tag", "v1"]);
    assert!(!local_work(&entry), "a tag has it");

    // A detached HEAD's commits are nobody's but its own.
    git(&repo, &["checkout", "-q", "--detach"]);
    std::fs::write(repo.join("c.txt"), "c").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "detached"]);
    assert!(local_work(&entry));

    // No worktree of its own, its workspace removed, or its folder gone: nothing to finish there.
    let mut on_main = entry.clone();
    on_main.worktree_name = None;
    assert!(!local_work(&on_main));
    let mut removed = entry.clone();
    removed.worktree_removed = true;
    assert!(!local_work(&removed));
    assert!(!local_work(&in_worktree(&dir.path().join("gone"))));
    // A folder git cannot read: not knowing is not finished.
    let plain = dir.path().join("plain");
    std::fs::create_dir(&plain).unwrap();
    assert!(local_work(&in_worktree(&plain)));
}

#[test]
fn a_pipeline_keeps_its_sessions_until_its_pull_request_merges_or_closes() {
    let _home = store::temp_home();
    let pipeline = |id: &str, state: &str, reason: Value, pr: bool| -> crate::issue_pipeline::Pipeline {
        let mut value = json!({
            "id": id, "projectPath": "/work", "branch": format!("raccoon/{id}"),
            "author": { "sessionId": format!("{id}-author"), "tabId": "t" },
            "reviewer": { "sessionId": format!("{id}-reviewer"), "tabId": "t" },
            "stage": "review", "state": state, "maxRounds": 3, "created": stamp(now()), "modified": stamp(now()),
        });
        if !reason.is_null() {
            value["reason"] = reason;
        }
        if pr {
            value["pr"] = json!({ "number": 7, "url": "https://github.com/acme/api/pull/7", "base": "main" });
        }
        serde_json::from_value(value).unwrap()
    };
    for pipeline in [
        pipeline("working", "working", Value::Null, true),
        pipeline("ready", "readyToMerge", json!({"kind": "autoMergeOff"}), true),
        pipeline("merged", "merged", Value::Null, true),
        pipeline("closed", "needsYou", json!({"kind": "pullRequestClosed"}), true),
        pipeline("stopped-open", "stopped", Value::Null, true),
        pipeline("stopped-early", "stopped", Value::Null, false),
    ] {
        crate::issue_pipeline::store::insert(&pipeline).unwrap();
    }
    let mut open: Vec<String> = in_open_pipelines().unwrap().into_iter().collect();
    open.sort();
    assert_eq!(open, ["ready-author", "ready-reviewer", "stopped-open-author", "stopped-open-reviewer", "working-author", "working-reviewer"]);
}
