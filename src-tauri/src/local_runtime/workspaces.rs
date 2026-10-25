//! Local workspace mutations execute beside their processes, never against a
//! disconnected desktop cache. Cloud confinement and scheduling stay separate.
use std::path::{Path, PathBuf};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::{session::SessionManager, sink::EventSink, store::{index::SessionEntry, projects}, worktree_cleanup as cleanup};

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params[key].as_str().with_context(|| format!("{key} is required"))
}

fn host<R>(manager: &SessionManager, f: impl FnOnce(&cleanup::Host<'_>) -> Result<R>) -> Result<R> {
    let (projects, _) = projects::list()?;
    let (open, archived): (Vec<_>, Vec<_>) = projects.into_iter().partition(|project| !project.archived);
    let protected: Vec<PathBuf> = archived.into_iter().map(|project| project.path.into()).collect();
    let running = |session: &str, tab: &str| manager.is_running(session, tab);
    let live = |sessions: &[SessionEntry]| {
        let mut live = cleanup::Live::observe(manager.terminals(), sessions, &running);
        live.turns = sessions.iter().flat_map(|session| session.tabs.iter()
            .filter(|tab| !manager.pipeline_idle(&session.id, &tab.id))
            .map(|tab| (session.id.clone(), tab.id.clone()))).collect();
        live
    };
    f(&cleanup::Host { projects: &open, protected: &protected, confine: None, live: &live, fetch: crate::landed::Fetch::Fresh })
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Removal {
    project_path: String,
    path: String,
    keep_sessions: bool,
    delete_branch: bool,
    confirmed_digest: Option<String>,
    expected_sessions: Vec<String>,
}

pub(crate) fn execute(manager: &SessionManager, sink: &dyn EventSink, method: &str, params: Value) -> Result<Value> {
    // Cancellation must not wait behind the operation it is cancelling.
    if method == "cancelSizes" {
        cleanup::Jobs::sizes().cancel(&format!("local:{}", text(&params,"prefix")?));
        return Ok(Value::Null);
    }
    if method == "cancelRemove" {
        let prefix = text(&params,"prefix")?;
        if !prefix.is_empty() { cleanup::Jobs::removals().cancel(prefix); }
        return Ok(Value::Null);
    }
    let _admission = crate::issue_pipeline::admission::lock();
    manager.accepting_work()?;
    let stop = |entry: &SessionEntry| manager.stop_session_confirmed(entry).map_err(|error| format!("{error:#}"));
    match method {
        "scan" => host(manager, |host| {
            let paths: Option<Vec<String>> = serde_json::from_value(params["projectPaths"].clone())?;
            Ok(serde_json::to_value(cleanup::scan(host,paths.as_deref())?)?)
        }),
        "size" => host(manager, |host| Ok(json!(cleanup::estimate_size(host, cleanup::Jobs::sizes(),
            &format!("local:{}",text(&params,"job")?),text(&params,"projectPath")?,text(&params,"path")?)?))),
        "remove" => host(manager, |host| {
            let items: Vec<cleanup::RemoveItem> = serde_json::from_value(params["items"].clone())?;
            let run = params["run"].as_str().unwrap_or_default();
            let report = |progress: &cleanup::Progress| sink.emit(cleanup::PROGRESS_EVENT, &cleanup::OfRun { run, progress });
            let stopped = cleanup::Jobs::removals().start(run);
            let results = cleanup::remove(host,sink,&items,cleanup::Watch { report: Some(&report), stop: Some(&stopped) });
            cleanup::Jobs::removals().finish(&stopped);
            Ok(serde_json::to_value(results)?)
        }),
        "removeWorkspace" => {
            let params: Removal = serde_json::from_value(params)?;
            let direct = if params.confirmed_digest.is_some() { crate::git::DirectDelete::Allowed } else { crate::git::DirectDelete::Never };
            let request = crate::session_ops::WorkspaceRemoval {
                project_path: &params.project_path, path: &params.path,
                sessions: if params.keep_sessions { crate::session_ops::SessionsFate::Keep } else { crate::session_ops::SessionsFate::Delete },
                delete_branch: params.delete_branch,
                confirmation: params.confirmed_digest.map(crate::session_ops::Confirmation::Shown).unwrap_or(crate::session_ops::Confirmation::Single),
                expected_sessions: Some(&params.expected_sessions), direct, fetch: crate::landed::Fetch::Fresh, guard: None,
            };
            let removed = crate::session_ops::remove_workspace_fallible(sink,&request,&stop).map_err(anyhow::Error::msg)?;
            Ok(json!({"sessions":removed.sessions,"keptBranch":removed.removal.kept_branch,"rescuedBranch":removed.removal.rescued_branch}))
        }
        "mergedSweep" => host(manager, |host| {
            let settings = crate::store::settings::load().merged_cleanup;
            let scope = crate::merged_cleanup::Scope {
                projects: host.projects.iter().filter(|project| settings.enabled_for(&project.path)).map(|project| project.path.clone()).collect(),
                delete_sessions: settings.delete_conversations, grace_seconds: u64::from(settings.grace_minutes)*60,
            };
            let pull_requests = |cwd: &Path, branches: &[String]| crate::github::branch_prs(cwd,branches);
            let run = crate::merged_cleanup::FallibleSweep { host, sink, stop: &stop, pull_requests: &pull_requests, now: chrono::Utc::now() };
            Ok(serde_json::to_value(crate::merged_cleanup::sweep_fallible(&run,&scope)?)?)
        }),
        "mergedRecords" => host(manager, |host| Ok(serde_json::to_value(crate::merged_cleanup::records(host)?)?)),
        "mergedRestore" => host(manager, |host| Ok(serde_json::to_value(crate::merged_cleanup::restore(host,sink,text(&params,"id")?,chrono::Utc::now())?)?)),
        "mergedHold" => { crate::merged_cleanup::hold(text(&params,"path")?,params["held"].as_bool().context("held is required")?,chrono::Utc::now())?; Ok(Value::Null) }
        "quickCwd" => {
            let stop_agents = |entry: &SessionEntry| manager.stop_agents_confirmed(entry).map_err(|error| format!("{error:#}"));
            Ok(serde_json::to_value(crate::session_ops::set_quick_chat_cwd_fallible(sink,text(&params,"sessionId")?,params["cwd"].as_str(),&stop_agents).map_err(anyhow::Error::msg)?)?)
        }
        "quickMove" => {
            let stop_agents = |entry: &SessionEntry| manager.stop_agents_confirmed(entry).map_err(|error| format!("{error:#}"));
            let moved = crate::session_ops::move_quick_chat_to_project_fallible(sink,text(&params,"sessionId")?,text(&params,"projectPath")?,&stop_agents).map_err(anyhow::Error::msg)?;
            sink.emit("projects_changed", &());
            Ok(serde_json::to_value(moved)?)
        }
        "relocate" => {
            let id = text(&params,"sessionId")?;
            let entry = crate::store::index::get(id)?;
            if entry.worktree_name.is_none() { bail!("session has no worktree"); }
            manager.stop_agents_confirmed(&entry)?;
            let branch = crate::git::current_branch(Path::new(&entry.project_path));
            let updated = crate::store::index::update_session(id, |entry| {
                entry.cwd = entry.project_path.clone();
                entry.worktree_name = None;
                entry.worktree_removed = false;
                entry.removed_workspace = None;
                entry.branch = branch.clone();
                entry.base_ref = None;
                for tab in &mut entry.tabs { tab.status = crate::store::index::TabStatus::Idle; }
                Ok(entry.clone())
            })?;
            sink.emit("session_updated", &updated);
            Ok(serde_json::to_value(updated)?)
        }
        "retention" => {
            let shells = manager.terminals().shells();
            let live: Vec<_> = shells.iter().filter(|shell| !shell.exited).map(|shell| shell.session_id.as_str()).collect();
            let busy = |session: &SessionEntry| session.tabs.iter().any(|tab| !manager.pipeline_idle(&session.id,&tab.id))
                || crate::session_ops::has_shell_in_use(session,&live,|pane| manager.terminals().is_running(pane));
            let days = crate::store::settings::load().floating.retention_days;
            let removed = crate::session_ops::sweep_idle_quick_chats_fallible(sink,days,&busy,&stop).map_err(anyhow::Error::msg)?;
            let orphans = crate::session_ops::remove_orphan_scratch(std::time::Duration::from_secs(60*60));
            Ok(json!({"removed":removed.len(),"orphans":orphans}))
        }
        _ => bail!("unsupported owner workspace operation"),
    }
}

/// Retention is a background-owner duty, but the sleeping timer is not work
/// that keeps an otherwise idle owner alive. An active sweep holds a request.
pub(crate) fn start_retention(manager: SessionManager, lifetime: std::sync::Arc<super::Lifetime>) {
    if let Err(error) = std::thread::Builder::new().name("local-retention".into()).spawn(move || loop {
        {
            let Ok(_request) = lifetime.enter() else { break };
            if let Err(error) = manager.workspace("retention", json!({})) {
                log::warn!("local quick-chat retention: {error:#}");
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(6 * 60 * 60));
    }) { log::warn!("start local quick-chat retention: {error:#}"); }
}
