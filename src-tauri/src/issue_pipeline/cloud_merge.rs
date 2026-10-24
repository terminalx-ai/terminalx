//! A cloud workspace's pull request, merged from the desktop (#433).
//!
//! The workspace's runtime carries a pipeline to *Ready to merge* and stops:
//! its GitHub token is the workspace's, not the reader's. The merge is made
//! here, with the reader's own `gh`, when they press Merge on the issue page.
//! The pipeline as the runtime reports it names the pull request and the
//! commit that was reviewed. Everything that would make the merge wrong is
//! read again from GitHub first, and the merge is pinned to the reviewed
//! commit, as a merge of a pipeline on this computer is.

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::github::{PinnedMerge, PrSnapshot};
use crate::store::projects::IssuePipelineSettings;

use super::gate::{self, Facts, Gate, StopReason, Wait};
use super::{Pipeline, State};

/// GitHub as the reader's own `gh` sees it.
pub trait Github {
    fn pull_request(&self, repository: &str, number: u64) -> Result<PrSnapshot>;
    /// Merge only if the head is still `commit`.
    fn merge(&self, repository: &str, number: u64, method: &str, commit: &str) -> Result<PinnedMerge>;
}

pub struct ReadersGh;

impl Github for ReadersGh {
    fn pull_request(&self, repository: &str, number: u64) -> Result<PrSnapshot> {
        crate::github::pr_snapshot_in(repository, number)
    }

    fn merge(&self, repository: &str, number: u64, method: &str, commit: &str) -> Result<PinnedMerge> {
        crate::github::merge_pr_at_in(repository, number, method, commit)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CloudMerge {
    /// Merged at `commit`: the reviewed one.
    Merged { commit: String },
    /// GitHub took it into a merge queue and merges it later.
    Accepted { commit: String },
    /// Someone merged it already, somewhere else.
    AlreadyMerged { commit: String },
    /// Nothing was merged, for this reason.
    NotMerged { reason: String },
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

/// Merge the pull request of a cloud workspace's `pipeline` as the person who
/// pressed Merge. `repository` is the cloud project's own (`owner/name`): a
/// pull request anywhere else is refused, whatever the workspace reports.
pub fn merge(github: &dyn Github, pipeline: &Pipeline, repository: &str, settings: &IssuePipelineSettings) -> Result<CloudMerge> {
    let issue = pipeline.label();
    if !pipeline.cloud {
        bail!("{issue} is not carried by a cloud workspace.");
    }
    if pipeline.stopped {
        bail!("{issue} is stopped. Resume it first.");
    }
    if pipeline.state != State::ReadyToMerge {
        bail!("{issue} is not at Ready to merge.");
    }
    let link = pipeline.pr.as_ref().with_context(|| format!("{issue} has no pull request."))?;
    let verdict = pipeline.verdict.as_ref().with_context(|| format!("{issue} has not been reviewed."))?;
    let (named, number) = crate::github::pr_url_parts(&link.url).with_context(|| format!("{} is not a pull request on GitHub.", link.url))?;
    if !named.eq_ignore_ascii_case(repository) || number != link.number {
        bail!("The pull request is {}, which is not in {repository}, this project's repository. Nothing was merged.", link.url);
    }

    let pr = github.pull_request(&named, number)?;
    // Only the branch the pipeline opened it from is the change that was reviewed.
    if pr.state == "OPEN" && pr.head != pipeline.branch {
        return Ok(CloudMerge::NotMerged { reason: format!("Pull request #{number} is from {}, not from {}, the branch this issue's pipeline opened it from.", pr.head, pipeline.branch) });
    }
    if pr.state == "OPEN" && pipeline.failed_local_checks.iter().any(|failed| super::gate::same_commit(failed, &pr.head_sha)) {
        return Ok(CloudMerge::NotMerged { reason: StopReason::LocalChecksFailed.describe() });
    }
    let local_passed = settings.local_check_command.as_deref().filter(|command| !command.trim().is_empty()).is_some_and(|command|
        pipeline.local_check.as_ref().is_some_and(|check| check.command == command && gate::same_commit(&check.head, &pr.head_sha)));
    if pr.state == "OPEN" && settings.local_check_command.as_ref().is_some_and(|command| !command.trim().is_empty()) && !local_passed {
        return Ok(CloudMerge::NotMerged { reason: "TerminalX has not passed the configured local check command on this final head.".into() });
    }
    // As for a person pressing Merge on this computer: everything that makes
    // a merge wrong applies, none of the holds that wait for a person.
    let decision = gate::decide_with_local(&Facts {
        auto_merge: true,
        require_person: false,
        cloud: false,
        verdict: Some(verdict),
        pr: &pr,
        security_areas: &pipeline.security_areas,
        protected: &[],
        ignored_checks: &settings.ignored_checks,
        allow_no_ci: settings.allow_no_ci,
    }, settings.local_checks_only && local_passed);
    let not_merged = |reason: StopReason| Ok(CloudMerge::NotMerged { reason: reason.describe() });
    match decision {
        Gate::Merged => Ok(CloudMerge::AlreadyMerged { commit: pr.head_sha }),
        Gate::Merge { commit } => match github.merge(&named, number, &settings.merge_method, &commit) {
            Ok(PinnedMerge::Merged) => Ok(CloudMerge::Merged { commit }),
            Ok(PinnedMerge::Accepted) => Ok(CloudMerge::Accepted { commit }),
            Ok(PinnedMerge::HeadMoved { head }) => not_merged(StopReason::HeadMoved { reviewed: commit, head }),
            Ok(PinnedMerge::Refused(message)) => not_merged(StopReason::MergeRefused { message }),
            // The request may have reached GitHub all the same: the pull request knows.
            Err(error) => match github.pull_request(&named, number) {
                Ok(now) if now.state == "MERGED" => Ok(CloudMerge::Merged { commit: now.head_sha }),
                _ => Err(error),
            },
        },
        Gate::Wait(Wait::Checks(names)) => Ok(CloudMerge::NotMerged { reason: format!("Checks are still running on {}: {}.", short(&pr.head_sha), names.join(", ")) }),
        Gate::Wait(Wait::Mergeability) => Ok(CloudMerge::NotMerged { reason: "GitHub has not worked out yet whether the branch merges. Try again in a moment.".into() }),
        Gate::ReadyToMerge(reason) | Gate::NeedsYou(reason) => not_merged(reason),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::issue_pipeline::gate::tests::{check, clean_pr, merge_verdict, HEAD, NEXT};
    use crate::issue_pipeline::{PrLink, SessionRef, Stage};
    use crate::store::index::IssueRef;

    struct FakeGithub {
        pr: Mutex<PrSnapshot>,
        answer: Mutex<Option<PinnedMerge>>,
        /// The merge call fails with this, after GitHub moved the pull request to `then`.
        fail: Mutex<Option<String>>,
        then: Mutex<Option<String>>,
        asked: Mutex<Vec<String>>,
        merges: Mutex<Vec<(String, u64, String, String)>>,
    }

    impl FakeGithub {
        fn new(pr: PrSnapshot) -> Self {
            Self { pr: Mutex::new(pr), answer: Mutex::new(None), fail: Mutex::new(None), then: Mutex::new(None), asked: Mutex::new(Vec::new()), merges: Mutex::new(Vec::new()) }
        }
    }

    impl Github for FakeGithub {
        fn pull_request(&self, repository: &str, number: u64) -> Result<PrSnapshot> {
            self.asked.lock().unwrap().push(format!("{repository}#{number}"));
            Ok(self.pr.lock().unwrap().clone())
        }

        fn merge(&self, repository: &str, number: u64, method: &str, commit: &str) -> Result<PinnedMerge> {
            self.merges.lock().unwrap().push((repository.into(), number, method.into(), commit.into()));
            if let Some(error) = self.fail.lock().unwrap().take() {
                // The answer is lost; what GitHub did is in the pull request.
                if let Some(state) = self.then.lock().unwrap().take() {
                    self.pr.lock().unwrap().state = state;
                }
                anyhow::bail!("{error}");
            }
            Ok(self.answer.lock().unwrap().take().unwrap_or(PinnedMerge::Merged))
        }
    }

    fn ready() -> Pipeline {
        Pipeline {
            id: "p1".into(),
            project_path: "/workspace".into(),
            issue: Some(IssueRef { provider: "github".into(), id: "433".into(), identifier: "#433".into(), title: "Pipeline".into(), url: "https://github.com/acme/widgets/issues/433".into() }),
            branch: "raccoon/11-fix-login-timeout".into(),
            author: SessionRef { session_id: "author".into(), tab_id: "t1".into() },
            reviewer: Some(SessionRef { session_id: "reviewer".into(), tab_id: "t1".into() }),
            auto_merge: false,
            resolver: None,
            resolution: None,
            resolutions: 0,
            resolve_conflicts: false,
            cloud: true,
            issue_body: None,
            stopped: false,
            stage: Stage::Merge,
            state: State::ReadyToMerge,
            reason: Some(StopReason::CloudWorkspace),
            note: None,
            pr: Some(PrLink { number: 7, url: "https://github.com/acme/widgets/pull/7".into(), base: "main".into() }),
            round: 1,
            max_rounds: 3,
            review_commit: Some(HEAD.into()),
            review_requested_at: None,
            findings_sent_round: 0,
            verdict: Some(merge_verdict(HEAD)),
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

    fn settings() -> IssuePipelineSettings {
        IssuePipelineSettings { merge_method: "squash".into(), ..Default::default() }
    }

    #[test]
    fn desktop_authority_cannot_override_known_local_check_failures() {
        let github = FakeGithub::new(clean_pr());
        let mut pipeline = ready();
        pipeline.failed_local_checks = vec![HEAD.into()];
        assert_eq!(merge(&github, &pipeline, "acme/widgets", &settings()).unwrap(), CloudMerge::NotMerged { reason: StopReason::LocalChecksFailed.describe() });
        assert!(github.merges.lock().unwrap().is_empty());
    }

    #[test]
    fn a_reviewed_green_pull_request_is_merged_with_the_readers_gh_pinned_to_the_reviewed_commit() {
        let github = FakeGithub::new(clean_pr());
        let merged = merge(&github, &ready(), "Acme/Widgets", &settings()).unwrap();
        assert_eq!(merged, CloudMerge::Merged { commit: HEAD.into() });
        assert_eq!(*github.asked.lock().unwrap(), ["acme/widgets#7"]);
        assert_eq!(*github.merges.lock().unwrap(), [("acme/widgets".to_string(), 7, "squash".to_string(), HEAD.to_string())]);
        // A merge queue takes it and merges later.
        let queued = FakeGithub::new(clean_pr());
        *queued.answer.lock().unwrap() = Some(PinnedMerge::Accepted);
        assert_eq!(merge(&queued, &ready(), "acme/widgets", &settings()).unwrap(), CloudMerge::Accepted { commit: HEAD.into() });
    }

    #[test]
    fn a_merge_whose_answer_was_lost_is_settled_by_reading_the_pull_request() {
        // It went through: said as a merge, so the runtime is told.
        let lost = FakeGithub::new(clean_pr());
        *lost.fail.lock().unwrap() = Some("gh pr merge: connection reset".into());
        *lost.then.lock().unwrap() = Some("MERGED".into());
        assert_eq!(merge(&lost, &ready(), "acme/widgets", &settings()).unwrap(), CloudMerge::Merged { commit: HEAD.into() });
        // It did not: the error stands.
        let failed = FakeGithub::new(clean_pr());
        *failed.fail.lock().unwrap() = Some("gh pr merge: connection reset".into());
        assert!(merge(&failed, &ready(), "acme/widgets", &settings()).unwrap_err().to_string().contains("connection reset"));
    }

    #[test]
    fn a_head_that_moved_after_the_review_is_not_merged_whether_seen_first_or_refused_by_github() {
        // Seen when the pull request is read.
        let mut moved = clean_pr();
        moved.head_sha = NEXT.into();
        let github = FakeGithub::new(moved);
        let refused = merge(&github, &ready(), "acme/widgets", &settings()).unwrap();
        assert!(matches!(&refused, CloudMerge::NotMerged { reason } if reason.contains("moved to 2222222222")), "{refused:?}");
        assert!(github.merges.lock().unwrap().is_empty());
        // Or a push between that read and the merge: GitHub refuses the pinned merge.
        let raced = FakeGithub::new(clean_pr());
        *raced.answer.lock().unwrap() = Some(PinnedMerge::HeadMoved { head: NEXT.into() });
        let refused = merge(&raced, &ready(), "acme/widgets", &settings()).unwrap();
        assert!(matches!(&refused, CloudMerge::NotMerged { reason } if reason.contains("moved to 2222222222")), "{refused:?}");
        assert_eq!(raced.merges.lock().unwrap()[0].3, HEAD, "asked for the reviewed commit only");
    }

    #[test]
    fn whatever_makes_a_merge_wrong_stops_it_and_says_why() {
        let failing = { let mut pr = clean_pr(); pr.checks = vec![check("build", "failure")]; pr };
        let running = { let mut pr = clean_pr(); pr.checks = vec![check("build", "in_progress")]; pr };
        let conflicting = { let mut pr = clean_pr(); pr.mergeable = "CONFLICTING".into(); pr };
        let other_branch = { let mut pr = clean_pr(); pr.head = "someone/else".into(); pr };
        for (pr, says) in [(failing, "failed on the reviewed commit"), (running, "still running"), (conflicting, "conflicts"), (other_branch, "not from raccoon/11-fix-login-timeout")] {
            let github = FakeGithub::new(pr);
            match merge(&github, &ready(), "acme/widgets", &settings()).unwrap() {
                CloudMerge::NotMerged { reason } => assert!(reason.contains(says), "{reason}"),
                other => panic!("{says}: {other:?}"),
            }
            assert!(github.merges.lock().unwrap().is_empty(), "{says}");
        }
        // A check the project says never holds a merge does not, as on this computer.
        let flaky = { let mut pr = clean_pr(); pr.checks.push(check("flaky-e2e", "failure")); pr };
        let ignoring = IssuePipelineSettings { ignored_checks: vec!["flaky".into()], ..settings() };
        assert_eq!(merge(&FakeGithub::new(flaky), &ready(), "acme/widgets", &ignoring).unwrap(), CloudMerge::Merged { commit: HEAD.into() });
        // Checks this person's own sign-in may not read are not taken as passed.
        let unread = { let mut pr = clean_pr(); pr.checks.clear(); pr.checks_unread = true; pr };
        assert!(matches!(merge(&FakeGithub::new(unread), &ready(), "acme/widgets", &settings()).unwrap(), CloudMerge::NotMerged { reason } if reason.contains("your sign-in")));
        // GitHub's own refusal, in its words.
        let protected = FakeGithub::new(clean_pr());
        *protected.answer.lock().unwrap() = Some(PinnedMerge::Refused("the base branch policy prohibits the merge".into()));
        assert!(matches!(merge(&protected, &ready(), "acme/widgets", &settings()).unwrap(), CloudMerge::NotMerged { reason } if reason.contains("base branch policy")));
        // Merged meanwhile by someone else: said as that, not as this person's merge.
        let merged = { let mut pr = clean_pr(); pr.state = "MERGED".into(); pr };
        assert_eq!(merge(&FakeGithub::new(merged), &ready(), "acme/widgets", &settings()).unwrap(), CloudMerge::AlreadyMerged { commit: HEAD.into() });
    }

    #[test]
    fn only_a_cloud_pipeline_at_ready_to_merge_with_a_pull_request_in_the_projects_repository_is_merged() {
        let github = FakeGithub::new(clean_pr());
        let refused = |pipeline: Pipeline, repository: &str| merge(&github, &pipeline, repository, &settings()).unwrap_err().to_string();
        // A workspace that names a pull request in another repository is not followed there.
        let mut elsewhere = ready();
        elsewhere.pr.as_mut().unwrap().url = "https://github.com/someone/else/pull/7".into();
        assert!(refused(elsewhere, "acme/widgets").contains("not in acme/widgets"));
        let mut renumbered = ready();
        renumbered.pr.as_mut().unwrap().number = 8;
        assert!(refused(renumbered, "acme/widgets").contains("Nothing was merged"));
        assert!(refused(Pipeline { state: State::NeedsYou, ..ready() }, "acme/widgets").contains("not at Ready to merge"));
        assert!(refused(Pipeline { stopped: true, ..ready() }, "acme/widgets").contains("stopped"));
        assert!(refused(Pipeline { cloud: false, ..ready() }, "acme/widgets").contains("not carried by a cloud workspace"));
        assert!(refused(Pipeline { verdict: None, ..ready() }, "acme/widgets").contains("not been reviewed"));
        assert!(github.asked.lock().unwrap().is_empty() && github.merges.lock().unwrap().is_empty());
    }
}
