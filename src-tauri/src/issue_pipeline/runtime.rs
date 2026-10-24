//! The pipeline in a cloud workspace's runtime (`terminalx-serve`): the same
//! engine as on the desktop, moved by the same turn ends, with nobody's
//! window open. A desktop that attaches reads and steers it over the
//! workspace RPC (`pipeline/1`); it never needs one to carry on.

use std::sync::{Arc, OnceLock};

use crate::sink::SessionObserver;

use super::host::LocalHost;
use super::{engine, store};

/// The runtime's session observer. It is built before the session manager
/// (which takes it) and given its host once the manager and the agent tabs
/// exist; until then, and in a runtime that serves no agent tabs, a turn
/// ending moves nothing.
#[derive(Default)]
pub struct RuntimeObserver {
    host: OnceLock<Arc<LocalHost>>,
}

impl RuntimeObserver {
    pub fn attach(&self, host: Arc<LocalHost>) {
        let _ = self.host.set(host);
    }

    fn off_thread(&self, session_id: &str, tab_id: &str, work: impl FnOnce(&LocalHost) + Send + 'static) {
        let Some(host) = self.host.get().cloned() else {
            return;
        };
        if !store::takes_part(session_id, tab_id) {
            return;
        }
        let _ = std::thread::Builder::new().name("issue-pipeline".into()).spawn(move || work(&host));
    }
}

impl SessionObserver for RuntimeObserver {
    fn automation_completed(&self, session_id: &str, tab_id: &str, final_message: Option<String>) {
        let (session, tab) = (session_id.to_string(), tab_id.to_string());
        self.off_thread(session_id, tab_id, move |host| engine::turn_completed(host, &session, &tab, final_message.as_deref()));
    }

    fn automation_failed(&self, session_id: &str, tab_id: &str, message: &str) {
        let (session, tab) = (session_id.to_string(), tab_id.to_string());
        let detail = engine::turn_failure(message.contains("interrupted"));
        self.off_thread(session_id, tab_id, move |host| engine::turn_failed(host, &session, &tab, detail));
    }
}

/// Pick up the workspace's pipelines where they were and watch the pull
/// requests they wait on. `interrupted` are the agent tabs that were in a
/// turn when the previous runtime process ended.
pub fn start(host: Arc<LocalHost>, interrupted: Vec<(String, String)>) {
    let spawned = std::thread::Builder::new().name("issue-pipeline-poll".into()).spawn(move || {
        engine::resume(&*host, &interrupted);
        loop {
            std::thread::sleep(engine::POLL_EVERY);
            engine::poll(&*host);
        }
    });
    if let Err(error) = spawned {
        log::error!("start the issue pipeline poller: {error}");
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::issue_pipeline::{Pipeline, SessionRef, Stage, State, StopReason};
    use crate::sink::{BroadcastSink, EventSink};
    use crate::store::index::IssueRef;

    fn pipeline() -> Pipeline {
        Pipeline {
            id: "p1".into(),
            project_path: "/workspace".into(),
            issue: Some(IssueRef { provider: "github".into(), id: "433".into(), identifier: "#433".into(), title: "Pipeline".into(), url: "https://github.com/acme/api/issues/433".into() }),
            branch: "raccoon/433".into(),
            author: SessionRef { session_id: "author".into(), tab_id: "t1".into() },
            reviewer: None,
            resolver: None,
            resolution: None,
            resolutions: 0,
            resolve_conflicts: false,
            auto_merge: false,
            cloud: true,
            issue_body: None,
            stopped: false,
            stage: Stage::Work,
            state: State::Working,
            reason: None,
            note: None,
            pr: None,
            round: 0,
            max_rounds: 3,
            review_commit: None,
            review_requested_at: None,
            findings_sent_round: 0,
            verdict: None,
            failed_local_checks: Vec::new(),
        local_check: None,
        checking_locally: false,
            security_areas: Vec::new(),
            summary: None,
            reminded: false,
            waiting_since: None,
            merge_requested: None,
            merge_refused: None,
            merged: None,
            events: Vec::new(),
            created: "2026-10-18T00:00:00Z".into(),
            modified: "2026-10-18T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_turn_ending_in_the_runtime_moves_its_pipeline_once_the_host_is_there() {
        let _home = crate::store::temp_home();
        store::insert(&pipeline()).unwrap();
        let sink = std::sync::Arc::new(BroadcastSink::new(16));
        let manager = crate::session::SessionManager::new(
            sink.clone(),
            std::sync::Arc::new(crate::sink::NoObserver),
            std::sync::Arc::new(crate::harness::host::Host::new()),
            std::sync::Arc::new(crate::pty::Terminals::new()),
            std::sync::Arc::new(Default::default()),
            std::sync::Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        let blocked = "Stuck.\n\n```terminalx-status\n{\"status\": \"blocked\", \"checks\": \"none\", \"reason\": \"Which database?\"}\n```";
        let observer = RuntimeObserver::default();
        // Before the agent tabs are served there is no host: a turn ending moves nothing.
        observer.automation_completed("author", "t1", Some(blocked.into()));
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(store::get("p1").unwrap().state, State::Working);

        let announced = std::sync::Arc::new(std::sync::Mutex::new(0));
        let counted = announced.clone();
        sink.listen(crate::issue_pipeline::host::CHANGED, Box::new(move |_| *counted.lock().unwrap() += 1));
        observer.attach(std::sync::Arc::new(LocalHost::cloud_workspace(sink.clone() as std::sync::Arc<dyn EventSink>, manager, std::sync::Arc::new(|_: &str| {}))));
        // A tab that takes no part is not looked at.
        observer.automation_completed("someone", "else", Some(blocked.into()));
        // The author's is: off the hook's thread, and announced to whoever shows it.
        observer.automation_completed("author", "t1", Some(blocked.into()));
        let deadline = Instant::now() + Duration::from_secs(10);
        // Written, then announced: both are waited for.
        while (store::get("p1").unwrap().state != State::NeedsYou || *announced.lock().unwrap() == 0) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let moved = store::get("p1").unwrap();
        assert_eq!(moved.reason, Some(StopReason::AuthorNotDone { detail: "Which database?".into() }));
        assert!(*announced.lock().unwrap() >= 1);
    }
}
