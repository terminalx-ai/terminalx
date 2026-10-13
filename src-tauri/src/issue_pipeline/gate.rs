//! The merge gate: whether a pull request may be merged by TerminalX, and if
//! not, the one reason it stops.
//!
//! Everything here is a function of facts read at one moment: the reviewer's
//! last verdict, the pull request as GitHub reported it (head commit, checks
//! and mergeability from a single reply), what the diff touches, and the
//! switches. It touches nothing, so every stop reason can be checked without a
//! repository. The merge itself is then made with `--match-head-commit`, so a
//! head that moves after this decision is refused by GitHub rather than merged.

use serde::{Deserialize, Serialize};

use super::verdict::{Decision, SecurityPass, Severity, Verdict};
use crate::github::PrSnapshot;

/// How one check on the head commit stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckBucket {
    Pass,
    Fail,
    Pending,
}

/// `state` is a check's conclusion, or its status while it has none, in
/// lower case as `github::parse_pr` leaves it. A state this build has never
/// seen is still running as far as a merge is concerned.
pub fn check_bucket(state: &str) -> CheckBucket {
    match state {
        "success" | "neutral" | "skipped" => CheckBucket::Pass,
        "failure" | "error" | "cancelled" | "timed_out" | "action_required" | "startup_failure" | "stale" => CheckBucket::Fail,
        _ => CheckBucket::Pending,
    }
}

/// A category of change the project always wants a person to merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedHit {
    /// `migrations`, `deploy`, `security`, or `paths` for the project's own patterns.
    pub category: String,
    /// What put the diff in it: changed paths, or the reviewer's flagged findings.
    pub evidence: Vec<String>,
}

/// Why the pipeline stopped short of a merge. Each is shown on the issue page
/// as it reads. The first group is the merge gate's; the second is what can
/// stop a stage before the gate is ever reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StopReason {
    /// The switch is off: the default.
    AutoMergeOff,
    /// The project wants a person to press merge whatever the switch says.
    PersonRequired,
    ProtectedCategory { hits: Vec<ProtectedHit> },
    NoVerdict { detail: String },
    /// The reviewed commit is not the pull request's head any more.
    HeadMoved { reviewed: String, head: String },
    OpenFindings { count: usize, worst: Severity },
    ChangesRequested,
    /// The diff called for a security pass and the reviewer did not report one.
    SecurityPassMissing { areas: Vec<String> },
    ChecksFailed { names: Vec<String> },
    /// Checks that did not finish within the wait limit.
    ChecksStalled { names: Vec<String>, minutes: u32 },
    Conflicts,
    Draft,
    /// Branch protection wants an approving review TerminalX will not give itself.
    ReviewRequired,
    /// Branch protection blocks the merge for a reason GitHub did not break down.
    Blocked,
    /// The base branch moved and the repository requires the branch up to date.
    Behind,
    PullRequestClosed,
    /// GitHub refused the merge; its own words.
    MergeRefused { message: String },

    /// The author says the work is not finished; its own reason.
    AuthorNotDone { detail: String },
    LocalChecksFailed,
    UncommittedChanges { files: Vec<String> },
    /// The branch has no commit the base does not.
    NothingToReview,
    /// The review asked for changes and the author's turn ended without any.
    NoChangesMade,
    /// The checkout is not as it was when the review began, so the verdict
    /// is for something else.
    ReviewerChangedWorkspace { detail: String },
    /// The author's checkout is not on the pipeline's branch any more.
    WorkspaceMoved { expected: String, found: String },
    /// A session's turn ended without finishing: interrupted, or its agent quit.
    SessionStopped { role: String, detail: String },
    /// Still not clean after the last allowed review.
    RoundLimit { rounds: u32, count: usize, worst: Option<Severity> },
    /// A step failed for a reason of its own (push refused, GitHub unreachable).
    Failed { step: String, message: String },
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// A list a sentence can hold: the first few, then how many more.
fn some(items: &[String]) -> String {
    const SHOWN: usize = 4;
    let mut text = items.iter().take(SHOWN).cloned().collect::<Vec<_>>().join(", ");
    if items.len() > SHOWN {
        text.push_str(&format!(" and {} more", items.len() - SHOWN));
    }
    text
}

fn category_phrase(hit: &ProtectedHit) -> String {
    let what = match hit.category.as_str() {
        "migrations" => "database migrations",
        "deploy" => "deploy configuration",
        "security" => "something the security pass flagged",
        _ => "paths this project protects",
    };
    format!("{what} ({})", some(&hit.evidence))
}

impl StopReason {
    /// The reason as the issue page and the record say it.
    pub fn describe(&self) -> String {
        match self {
            Self::AutoMergeOff => "Reviewed, checks passed. Automatic merge is off for this issue.".into(),
            Self::PersonRequired => "Reviewed, checks passed. This project has a person do the merge.".into(),
            Self::ProtectedCategory { hits } => format!("Reviewed, checks passed. A person merges this one: it changes {}.", hits.iter().map(category_phrase).collect::<Vec<_>>().join("; ")),
            Self::NoVerdict { detail } => format!("There is no usable verdict from the reviewer. {detail}"),
            Self::HeadMoved { reviewed, head } => format!("The branch moved to {} after the review of {}. The new commit has not been reviewed.", short(head), short(reviewed)),
            Self::OpenFindings { count: n, worst } => format!("{} of medium severity or higher {} open (worst: {}).", count(*n, "finding", "findings"), if *n == 1 { "is" } else { "are" }, worst.label()),
            Self::ChangesRequested => "The reviewer asked for changes.".into(),
            Self::SecurityPassMissing { areas } => format!("The change touches {} and the reviewer reported no security pass.", some(areas)),
            Self::ChecksFailed { names } => format!("{} failed on the reviewed commit: {}.", if names.len() == 1 { "A check" } else { "Checks" }, some(names)),
            Self::ChecksStalled { names, minutes } => format!("Checks have not finished after {minutes} minutes: {}.", some(names)),
            Self::Conflicts => "The pull request conflicts with its base branch.".into(),
            Self::Draft => "The pull request is a draft.".into(),
            Self::ReviewRequired => "GitHub requires an approving review before this can merge. TerminalX does not approve its own pull requests.".into(),
            Self::Blocked => "Branch protection is blocking the merge.".into(),
            Self::Behind => "The branch is behind its base, and the repository requires it up to date before merging.".into(),
            Self::PullRequestClosed => "The pull request was closed without merging.".into(),
            Self::MergeRefused { message } => format!("GitHub refused the merge: {message}"),
            Self::AuthorNotDone { detail } => format!("The author session has not reported the work done. {detail}"),
            Self::LocalChecksFailed => "The author session reports that the project's checks did not pass.".into(),
            Self::UncommittedChanges { files } => format!("The workspace has uncommitted changes in {}: {}. Commit or discard them.", count(files.len(), "file", "files"), some(files)),
            Self::NothingToReview => "The branch has no commits of its own, so there is nothing to open a pull request for.".into(),
            Self::NoChangesMade => "The author session ended its turn without changing anything in response to the review.".into(),
            Self::ReviewerChangedWorkspace { detail } => format!("The workspace changed while it was being reviewed, so the verdict does not count: {detail}"),
            Self::WorkspaceMoved { expected, found } => format!("The session's checkout is on {found}, not on {expected}, the branch this pull request is opened from. Nothing was pushed."),
            Self::SessionStopped { role, detail } => format!("The {role} session stopped before it finished. {detail}"),
            Self::RoundLimit { rounds, count: n, worst } => match worst {
                Some(worst) => format!("Still not clean after {}: {} of medium severity or higher {} (worst: {}).", count(*rounds as usize, "review", "reviews"), count(*n, "finding", "findings"), if *n == 1 { "remains" } else { "remain" }, worst.label()),
                None => format!("The reviewer still asks for changes after {}.", count(*rounds as usize, "review", "reviews")),
            },
            Self::Failed { step, message } => format!("{step} did not work: {message}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wait {
    Checks(Vec<String>),
    /// GitHub has not finished working out whether the branch merges.
    Mergeability,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// Merge this exact commit.
    Merge { commit: String },
    /// Someone merged it already.
    Merged,
    Wait(Wait),
    /// Reviewed, checks passed, mergeable, and TerminalX will not merge it itself.
    ReadyToMerge(StopReason),
    NeedsYou(StopReason),
}

pub struct Facts<'a> {
    pub auto_merge: bool,
    pub require_person: bool,
    pub verdict: Option<&'a Verdict>,
    pub pr: &'a PrSnapshot,
    /// The areas TerminalX saw the diff touch that call for a security pass.
    pub security_areas: &'a [String],
    pub protected: &'a [ProtectedHit],
    /// Checks the project says never gate a merge. They only apply to checks
    /// branch protection does not require.
    pub ignored_checks: &'a [String],
}

/// A verdict that lets a merge go ahead: "merge", and nothing open at medium
/// severity or above.
pub fn verdict_blocker(verdict: &Verdict) -> Option<StopReason> {
    let open: Vec<&super::verdict::Finding> = verdict.findings.iter().filter(|finding| finding.severity >= Severity::Medium).collect();
    if let Some(worst) = open.iter().map(|finding| finding.severity).max() {
        return Some(StopReason::OpenFindings { count: open.len(), worst });
    }
    (verdict.decision != Decision::Merge).then_some(StopReason::ChangesRequested)
}

fn ignored(name: &str, patterns: &[String]) -> bool {
    let name = name.to_ascii_lowercase();
    patterns.iter().map(|pattern| pattern.trim().to_ascii_lowercase()).any(|pattern| !pattern.is_empty() && name.contains(&pattern))
}

/// The checks that gate this commit, as (failed, pending) names.
fn gating_checks(pr: &PrSnapshot, ignored_checks: &[String]) -> (Vec<String>, Vec<String>) {
    let mut failed = Vec::new();
    let mut pending = Vec::new();
    let mut sort = |name: &str, state: &str| match check_bucket(state) {
        CheckBucket::Pass => {}
        CheckBucket::Fail => failed.push(name.to_string()),
        CheckBucket::Pending => pending.push(name.to_string()),
    };
    match pr.required_checks.as_deref().filter(|required| !required.is_empty()) {
        Some(required) => {
            for name in required {
                // A check may run more than once on a commit; any failing run fails it.
                let runs: Vec<&crate::github::PrCheck> = pr.checks.iter().filter(|check| &check.name == name).collect();
                match runs.iter().map(|check| check_bucket(&check.state)).max_by_key(|bucket| match bucket {
                    CheckBucket::Fail => 2,
                    CheckBucket::Pending => 1,
                    CheckBucket::Pass => 0,
                }) {
                    Some(CheckBucket::Pass) => {}
                    Some(CheckBucket::Fail) => sort(name, "failure"),
                    // Required and not reported on this commit yet.
                    Some(CheckBucket::Pending) | None => sort(name, "pending"),
                }
            }
        }
        None => {
            for check in pr.checks.iter().filter(|check| !ignored(&check.name, ignored_checks)) {
                sort(&check.name, &check.state);
            }
        }
    }
    failed.sort();
    failed.dedup();
    pending.sort();
    pending.dedup();
    (failed, pending)
}

/// Decide. The order is the order a reader would want the reasons in: what is
/// wrong with the change first, then what GitHub still has to say, and only
/// then the switches that hold back a change with nothing wrong with it.
pub fn decide(facts: &Facts<'_>) -> Gate {
    let pr = facts.pr;
    match pr.state.as_str() {
        "MERGED" => return Gate::Merged,
        "CLOSED" => return Gate::NeedsYou(StopReason::PullRequestClosed),
        _ => {}
    }
    let Some(verdict) = facts.verdict else {
        return Gate::NeedsYou(StopReason::NoVerdict { detail: "The pull request has not been reviewed.".into() });
    };
    if !same_commit(&verdict.commit, &pr.head_sha) {
        return Gate::NeedsYou(StopReason::HeadMoved { reviewed: verdict.commit.clone(), head: pr.head_sha.clone() });
    }
    if let Some(reason) = verdict_blocker(verdict) {
        return Gate::NeedsYou(reason);
    }
    if !facts.security_areas.is_empty() && verdict.security_pass == SecurityPass::NotNeeded {
        return Gate::NeedsYou(StopReason::SecurityPassMissing { areas: facts.security_areas.to_vec() });
    }
    if pr.is_draft || pr.merge_state == "DRAFT" {
        return Gate::NeedsYou(StopReason::Draft);
    }
    if pr.mergeable == "CONFLICTING" || pr.merge_state == "DIRTY" {
        return Gate::NeedsYou(StopReason::Conflicts);
    }
    let (failed, pending) = gating_checks(pr, facts.ignored_checks);
    if !failed.is_empty() {
        return Gate::NeedsYou(StopReason::ChecksFailed { names: failed });
    }
    if !pending.is_empty() {
        return Gate::Wait(Wait::Checks(pending));
    }
    if pr.mergeable != "MERGEABLE" {
        return Gate::Wait(Wait::Mergeability);
    }
    if matches!(pr.review_decision.as_deref(), Some("REVIEW_REQUIRED" | "CHANGES_REQUESTED")) {
        return Gate::NeedsYou(StopReason::ReviewRequired);
    }
    match pr.merge_state.as_str() {
        "BEHIND" => return Gate::NeedsYou(StopReason::Behind),
        "BLOCKED" => return Gate::NeedsYou(StopReason::Blocked),
        _ => {}
    }
    if !facts.protected.is_empty() {
        return Gate::ReadyToMerge(StopReason::ProtectedCategory { hits: facts.protected.to_vec() });
    }
    if facts.require_person {
        return Gate::ReadyToMerge(StopReason::PersonRequired);
    }
    if !facts.auto_merge {
        return Gate::ReadyToMerge(StopReason::AutoMergeOff);
    }
    Gate::Merge { commit: pr.head_sha.clone() }
}

/// Two spellings of one commit. A reviewer may abbreviate; seven characters is
/// the shortest Git itself prints.
pub fn same_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim().to_ascii_lowercase(), b.trim().to_ascii_lowercase());
    let hex = |value: &str| value.len() >= 7 && value.chars().all(|ch| ch.is_ascii_hexdigit());
    hex(&a) && hex(&b) && (a.starts_with(&b) || b.starts_with(&a))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::github::PrCheck;
    use crate::issue_pipeline::verdict::Finding;

    pub(crate) const HEAD: &str = "1111111111111111111111111111111111111111";
    pub(crate) const NEXT: &str = "2222222222222222222222222222222222222222";

    pub(crate) fn check(name: &str, state: &str) -> PrCheck {
        PrCheck { name: name.into(), state: state.into(), url: None }
    }

    pub(crate) fn clean_pr() -> PrSnapshot {
        PrSnapshot {
            number: 7,
            url: "https://github.com/acme/widgets/pull/7".into(),
            title: "Fix login timeout".into(),
            body: "Closes #11".into(),
            state: "OPEN".into(),
            is_draft: false,
            base: "main".into(),
            head: "raccoon/11-fix-login-timeout".into(),
            head_sha: HEAD.into(),
            mergeable: "MERGEABLE".into(),
            merge_state: "CLEAN".into(),
            review_decision: None,
            checks: vec![check("build", "success"), check("lint", "skipped")],
            required_checks: None,
        }
    }

    pub(crate) fn merge_verdict(commit: &str) -> Verdict {
        Verdict { commit: commit.into(), decision: Decision::Merge, security_pass: SecurityPass::NotNeeded, findings: Vec::new(), round: 1, at: "2026-10-12T00:00:00.000Z".into() }
    }

    fn finding(severity: Severity) -> Finding {
        Finding { severity, title: "Something".into(), detail: None, file: None, line: None, security: false }
    }

    struct Case {
        auto_merge: bool,
        require_person: bool,
        verdict: Option<Verdict>,
        pr: PrSnapshot,
        security_areas: Vec<String>,
        protected: Vec<ProtectedHit>,
        ignored_checks: Vec<String>,
    }

    impl Case {
        /// Everything in order and the switch on: the one case that merges.
        fn clean() -> Self {
            Self { auto_merge: true, require_person: false, verdict: Some(merge_verdict(HEAD)), pr: clean_pr(), security_areas: Vec::new(), protected: Vec::new(), ignored_checks: Vec::new() }
        }

        fn decide(&self) -> Gate {
            decide(&Facts {
                auto_merge: self.auto_merge,
                require_person: self.require_person,
                verdict: self.verdict.as_ref(),
                pr: &self.pr,
                security_areas: &self.security_areas,
                protected: &self.protected,
                ignored_checks: &self.ignored_checks,
            })
        }
    }

    #[test]
    fn a_clean_pull_request_merges_the_reviewed_commit_only_with_the_switch_on() {
        let mut case = Case::clean();
        assert_eq!(case.decide(), Gate::Merge { commit: HEAD.into() });
        // An abbreviated commit in the verdict is still that commit.
        case.verdict = Some(merge_verdict(&HEAD[..10]));
        assert_eq!(case.decide(), Gate::Merge { commit: HEAD.into() });
        // The default: reviewed, green, and left for a person.
        case.auto_merge = false;
        assert_eq!(case.decide(), Gate::ReadyToMerge(StopReason::AutoMergeOff));
    }

    #[test]
    fn a_head_that_moved_after_the_verdict_is_not_merged() {
        let mut case = Case::clean();
        case.pr.head_sha = NEXT.into();
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::HeadMoved { reviewed: HEAD.into(), head: NEXT.into() }));
        // Nor is a verdict that names no commit at all, or too little of one.
        for vague in ["", "1111", "the latest commit"] {
            case.pr.head_sha = HEAD.into();
            case.verdict = Some(merge_verdict(vague));
            assert!(matches!(case.decide(), Gate::NeedsYou(StopReason::HeadMoved { .. })), "{vague:?}");
        }
    }

    #[test]
    fn no_verdict_is_no_merge() {
        let mut case = Case::clean();
        case.verdict = None;
        assert!(matches!(case.decide(), Gate::NeedsYou(StopReason::NoVerdict { .. })));
    }

    #[test]
    fn an_open_finding_of_medium_or_higher_stops_it_and_a_lower_one_does_not() {
        for severity in [Severity::Medium, Severity::High, Severity::Critical] {
            let mut case = Case::clean();
            // Even under a verdict that says "merge": the findings are what count.
            case.verdict.as_mut().unwrap().findings = vec![finding(Severity::Low), finding(severity)];
            assert_eq!(case.decide(), Gate::NeedsYou(StopReason::OpenFindings { count: 1, worst: severity }), "{severity:?}");
        }
        let mut case = Case::clean();
        case.verdict.as_mut().unwrap().findings = vec![finding(Severity::Low), finding(Severity::Nit)];
        assert_eq!(case.decide(), Gate::Merge { commit: HEAD.into() });
        // A reviewer who asks for changes without a blocking finding is still not saying merge.
        case.verdict.as_mut().unwrap().decision = Decision::Changes;
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::ChangesRequested));
    }

    #[test]
    fn a_required_security_pass_must_have_been_reported() {
        let mut case = Case::clean();
        case.security_areas = vec!["billing".into()];
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::SecurityPassMissing { areas: vec!["billing".into()] }));
        // A pass that flagged something was still a pass; what it found is judged as findings.
        case.verdict.as_mut().unwrap().security_pass = SecurityPass::Flagged;
        assert_eq!(case.decide(), Gate::Merge { commit: HEAD.into() });
        case.verdict.as_mut().unwrap().security_pass = SecurityPass::Clean;
        assert_eq!(case.decide(), Gate::Merge { commit: HEAD.into() });
    }

    #[test]
    fn a_failing_check_stops_it_and_a_running_one_waits() {
        let mut case = Case::clean();
        case.pr.checks = vec![check("build", "success"), check("test", "failure"), check("lint", "in_progress")];
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::ChecksFailed { names: vec!["test".into()] }));
        case.pr.checks = vec![check("build", "success"), check("lint", "in_progress"), check("e2e", "queued")];
        assert_eq!(case.decide(), Gate::Wait(Wait::Checks(vec!["e2e".into(), "lint".into()])));
        for failed in ["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"] {
            case.pr.checks = vec![check("build", failed)];
            assert!(matches!(case.decide(), Gate::NeedsYou(StopReason::ChecksFailed { .. })), "{failed}");
        }
        // A state nobody has seen before is not a pass.
        case.pr.checks = vec![check("build", "something_new")];
        assert_eq!(case.decide(), Gate::Wait(Wait::Checks(vec!["build".into()])));
        // No checks at all: nothing is required, so nothing is waited for.
        case.pr.checks = Vec::new();
        assert_eq!(case.decide(), Gate::Merge { commit: HEAD.into() });
    }

    #[test]
    fn required_checks_are_the_ones_that_gate_when_the_branch_names_any() {
        let mut case = Case::clean();
        case.pr.required_checks = Some(vec!["build".into(), "test".into()]);
        // An optional check failing does not gate; GitHub calls the result UNSTABLE.
        case.pr.checks = vec![check("build", "success"), check("test", "success"), check("windows", "failure")];
        case.pr.merge_state = "UNSTABLE".into();
        assert_eq!(case.decide(), Gate::Merge { commit: HEAD.into() });
        // A required check that has not reported on this commit is still owed.
        case.pr.checks = vec![check("build", "success")];
        assert_eq!(case.decide(), Gate::Wait(Wait::Checks(vec!["test".into()])));
        case.pr.checks = vec![check("build", "success"), check("test", "failure")];
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::ChecksFailed { names: vec!["test".into()] }));
        // A rerun that passes does not erase a run that failed on the same commit.
        case.pr.checks = vec![check("build", "success"), check("test", "failure"), check("test", "success")];
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::ChecksFailed { names: vec!["test".into()] }));
        // Ignoring is for optional checks only: a required one cannot be waved through.
        case.ignored_checks = vec!["test".into()];
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::ChecksFailed { names: vec!["test".into()] }));
    }

    #[test]
    fn a_check_the_project_ignores_does_not_gate_when_nothing_is_required() {
        let mut case = Case::clean();
        case.pr.checks = vec![check("build", "success"), check("desktop-platforms (windows-latest)", "queued")];
        assert_eq!(case.decide(), Gate::Wait(Wait::Checks(vec!["desktop-platforms (windows-latest)".into()])));
        case.ignored_checks = vec!["Windows-latest".into(), "  ".into()];
        assert_eq!(case.decide(), Gate::Merge { commit: HEAD.into() });
    }

    #[test]
    fn conflicts_drafts_and_branch_protection_stop_it() {
        let mut case = Case::clean();
        case.pr.mergeable = "CONFLICTING".into();
        case.pr.merge_state = "DIRTY".into();
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::Conflicts));

        let mut case = Case::clean();
        case.pr.is_draft = true;
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::Draft));

        let mut case = Case::clean();
        case.pr.mergeable = "UNKNOWN".into();
        case.pr.merge_state = "UNKNOWN".into();
        assert_eq!(case.decide(), Gate::Wait(Wait::Mergeability));

        for (decision, state, reason) in [
            (Some("REVIEW_REQUIRED"), "BLOCKED", StopReason::ReviewRequired),
            (Some("CHANGES_REQUESTED"), "BLOCKED", StopReason::ReviewRequired),
            (Some("APPROVED"), "BLOCKED", StopReason::Blocked),
            (None, "BEHIND", StopReason::Behind),
        ] {
            let mut case = Case::clean();
            case.pr.review_decision = decision.map(String::from);
            case.pr.merge_state = state.into();
            assert_eq!(case.decide(), Gate::NeedsYou(reason), "{decision:?} {state}");
        }
    }

    #[test]
    fn a_protected_category_or_a_project_that_wants_a_person_leaves_it_ready() {
        let hit = ProtectedHit { category: "migrations".into(), evidence: vec!["db/migrations/0042_add.sql".into()] };
        let mut case = Case::clean();
        case.protected = vec![hit.clone()];
        assert_eq!(case.decide(), Gate::ReadyToMerge(StopReason::ProtectedCategory { hits: vec![hit] }));

        let mut case = Case::clean();
        case.require_person = true;
        assert_eq!(case.decide(), Gate::ReadyToMerge(StopReason::PersonRequired));
        // Neither hides something that is actually wrong.
        case.pr.checks = vec![check("build", "failure")];
        assert!(matches!(case.decide(), Gate::NeedsYou(StopReason::ChecksFailed { .. })));
    }

    #[test]
    fn a_pull_request_that_is_no_longer_open_is_reported_as_it_is() {
        let mut case = Case::clean();
        case.pr.state = "MERGED".into();
        assert_eq!(case.decide(), Gate::Merged);
        case.pr.state = "CLOSED".into();
        assert_eq!(case.decide(), Gate::NeedsYou(StopReason::PullRequestClosed));
    }

    #[test]
    fn every_reason_reads_as_a_sentence_a_person_can_act_on() {
        let hit = |category: &str, evidence: &[&str]| ProtectedHit { category: category.into(), evidence: evidence.iter().map(|value| value.to_string()).collect() };
        for (reason, text) in [
            (StopReason::HeadMoved { reviewed: HEAD.into(), head: NEXT.into() }, "The branch moved to 2222222222 after the review of 1111111111. The new commit has not been reviewed."),
            (StopReason::OpenFindings { count: 1, worst: Severity::High }, "1 finding of medium severity or higher is open (worst: high)."),
            (StopReason::OpenFindings { count: 3, worst: Severity::Critical }, "3 findings of medium severity or higher are open (worst: critical)."),
            (StopReason::ChecksFailed { names: vec!["test".into()] }, "A check failed on the reviewed commit: test."),
            (StopReason::ChecksStalled { names: vec!["a".into(), "b".into(), "c".into(), "d".into(), "e".into(), "f".into()], minutes: 60 }, "Checks have not finished after 60 minutes: a, b, c, d and 2 more."),
            (
                StopReason::ProtectedCategory { hits: vec![hit("migrations", &["db/1.sql"]), hit("paths", &["billing/plans.ts"])] },
                "Reviewed, checks passed. A person merges this one: it changes database migrations (db/1.sql); paths this project protects (billing/plans.ts).",
            ),
            (StopReason::UncommittedChanges { files: vec!["a.rs".into()] }, "The workspace has uncommitted changes in 1 file: a.rs. Commit or discard them."),
            (StopReason::RoundLimit { rounds: 3, count: 2, worst: Some(Severity::Medium) }, "Still not clean after 3 reviews: 2 findings of medium severity or higher remain (worst: medium)."),
            (StopReason::RoundLimit { rounds: 1, count: 0, worst: None }, "The reviewer still asks for changes after 1 review."),
            (StopReason::Failed { step: "Pushing the branch".into(), message: "rejected".into() }, "Pushing the branch did not work: rejected"),
        ] {
            assert_eq!(reason.describe(), text);
        }
    }

    #[test]
    fn a_reason_is_stored_under_its_kind() {
        let stored = serde_json::to_value(StopReason::HeadMoved { reviewed: HEAD.into(), head: NEXT.into() }).unwrap();
        assert_eq!(stored, serde_json::json!({"kind": "headMoved", "reviewed": HEAD, "head": NEXT}));
        assert_eq!(serde_json::to_value(StopReason::AutoMergeOff).unwrap(), serde_json::json!({"kind": "autoMergeOff"}));
        assert_eq!(serde_json::from_value::<StopReason>(stored).unwrap(), StopReason::HeadMoved { reviewed: HEAD.into(), head: NEXT.into() });
    }

    #[test]
    fn commits_compare_by_prefix_and_only_as_hex() {
        assert!(same_commit(HEAD, &HEAD[..7]));
        assert!(same_commit(&HEAD[..12].to_uppercase(), HEAD));
        assert!(!same_commit(HEAD, NEXT));
        assert!(!same_commit(HEAD, &HEAD[..6]));
        assert!(!same_commit("", ""));
        assert!(!same_commit("zzzzzzz", "zzzzzzz"));
    }
}
