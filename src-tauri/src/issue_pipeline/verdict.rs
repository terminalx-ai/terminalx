//! What the two sessions report back, read out of their last message.
//!
//! The author ends a turn with a `terminalx-status` block and the reviewer
//! with a `terminalx-review` block; both are JSON in a fenced code block, so a
//! reply stays readable in the chat and the pipeline never has to guess from
//! prose. A reply without its block is not a report: nothing is inferred from
//! "looks good to me".

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const STATUS_FENCE: &str = "terminalx-status";
pub const REVIEW_FENCE: &str = "terminalx-review";

/// The most of a reviewer's note on its checks that is repeated.
const CHECKS_NOTE_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Nit,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    /// A severity nobody defined is treated as one that blocks: a reviewer who
    /// writes "serious" must not be read as "nothing to see".
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "nit" | "info" | "note" | "trivial" => Self::Nit,
            "low" | "minor" => Self::Low,
            "medium" | "moderate" => Self::Medium,
            "high" | "major" => Self::High,
            "critical" | "blocker" => Self::Critical,
            _ => Self::Medium,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Nit => "nit",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

impl<'de> Deserialize<'de> for Severity {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Self::parse(&String::deserialize(d)?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub severity: Severity,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// Raised by the security pass.
    #[serde(default)]
    pub security: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Merge,
    Changes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecurityPass {
    NotNeeded,
    Clean,
    Flagged,
}

/// Whether the reviewer ran the project's checks on the commit it judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewChecks {
    Passed,
    Failed,
    /// Judged by reading the code only: nothing ran, or nothing finished.
    NotRun,
}

impl ReviewChecks {
    /// Only an explicit pass is a pass, and only an explicit failure a
    /// failure. Anything else, the field left out included, did not run as
    /// far as anyone can tell.
    fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
            "passed" | "pass" | "success" => Self::Passed,
            "failed" | "fail" | "failure" | "error" => Self::Failed,
            _ => Self::NotRun,
        }
    }
}

/// One review of one commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// The commit the reviewer says it read. Compared with the pull request's
    /// head before anything is merged.
    pub commit: String,
    pub decision: Decision,
    pub security_pass: SecurityPass,
    /// Everything still open at this commit; a finding the author fixed is
    /// simply absent from the next review.
    pub findings: Vec<Finding>,
    /// What the reviewer's own checks came to. `None` only for a verdict
    /// stored before reviews said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<ReviewChecks>,
    /// The reviewer's few words on what ran, or why nothing did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks_note: Option<String>,
    pub round: u32,
    pub at: String,
}

impl Verdict {
    pub fn blocking(&self) -> impl Iterator<Item = &Finding> {
        self.findings.iter().filter(|finding| finding.severity >= Severity::Medium)
    }

    pub fn security_flagged(&self) -> bool {
        self.security_pass == SecurityPass::Flagged || self.findings.iter().any(|finding| finding.security)
    }

    /// The reviewer's checks in a sentence, for the record and the pull
    /// request. Nothing for a verdict stored before reviews said.
    pub fn checks_line(&self) -> Option<String> {
        // The reviewer's words, kept to one short line of the sentence they end.
        let mut note = self.checks_note.as_deref().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
        if note.chars().count() > CHECKS_NOTE_LIMIT {
            note = format!("{}…", note.chars().take(CHECKS_NOTE_LIMIT).collect::<String>().trim_end());
        }
        let with = |text: &str| match note.trim_end_matches('.') {
            "" => format!("{text}."),
            note => format!("{text}: {note}."),
        };
        Some(match self.checks? {
            ReviewChecks::Passed => with("The reviewer's checks passed"),
            ReviewChecks::Failed => with("The reviewer's checks failed"),
            ReviewChecks::NotRun => with("Reviewed by reading only, tests not run"),
        })
    }
}

/// The body of the last fenced block labelled `label`. A fence opens and
/// closes on a line of its own, so backticks inside the JSON (a finding that
/// quotes code) do not end the block, and a block shown inside another fenced
/// block, as when instructions are quoted back, is not a report.
fn last_block(text: &str, label: &str) -> Option<String> {
    enum Inside<'a> {
        Nothing,
        /// A block of ours, with its lines so far.
        Labelled(Vec<&'a str>),
        Other,
    }
    let mut found = None;
    let mut inside = Inside::Nothing;
    for line in text.lines() {
        let trimmed = line.trim();
        inside = match inside {
            Inside::Nothing => match trimmed.strip_prefix("```") {
                Some(info) if info.trim().eq_ignore_ascii_case(label) => Inside::Labelled(Vec::new()),
                Some(_) => Inside::Other,
                None => Inside::Nothing,
            },
            Inside::Labelled(lines) if trimmed == "```" => {
                found = Some(lines.join("\n"));
                Inside::Nothing
            }
            Inside::Labelled(mut lines) => {
                lines.push(line);
                Inside::Labelled(lines)
            }
            Inside::Other if trimmed == "```" => Inside::Nothing,
            Inside::Other => Inside::Other,
        };
    }
    found
}

fn text_field(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| value.get(name).and_then(Value::as_str)).map(str::trim).filter(|text| !text.is_empty()).map(String::from)
}

/// Whether the author says the work is finished and checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorReport {
    /// Done, with what the checks were and a summary for the pull request.
    Done { checks: LocalChecks, summary: Option<String> },
    /// Not done: the agent's own reason, when it gave one.
    NotDone { reason: Option<String> },
    /// No status block in the reply.
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalChecks {
    Passed,
    Failed,
    /// The project has nothing to run.
    None,
}

/// The explicit check result, including reports that say work is blocked.
pub fn reported_checks(message: &str) -> Option<LocalChecks> {
    let value = last_block(message, STATUS_FENCE).and_then(|block| serde_json::from_str::<Value>(&block).ok())?;
    Some(match text_field(&value, &["checks"])?.to_ascii_lowercase().as_str() {
        "passed" | "pass" => LocalChecks::Passed,
        "none" => LocalChecks::None,
        _ => LocalChecks::Failed,
    })
}

pub fn author_report(message: &str) -> AuthorReport {
    let Some(value) = last_block(message, STATUS_FENCE).and_then(|block| serde_json::from_str::<Value>(&block).ok()) else {
        return AuthorReport::Missing;
    };
    let status = text_field(&value, &["status"]).unwrap_or_default().to_ascii_lowercase();
    if status != "done" {
        return AuthorReport::NotDone { reason: text_field(&value, &["reason", "summary"]) };
    }
    let checks = match text_field(&value, &["checks"]).unwrap_or_default().to_ascii_lowercase().as_str() {
        "passed" | "pass" => LocalChecks::Passed,
        "none" => LocalChecks::None,
        // Anything else, "not_run" included, is not a pass.
        _ => LocalChecks::Failed,
    };
    AuthorReport::Done { checks, summary: text_field(&value, &["summary"]) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewError {
    /// No review block in the reply.
    Missing,
    Unreadable(String),
    /// Not a verdict yet: the reviewer says checks it started are still
    /// running, and what they are when it said.
    Pending(Option<String>),
}

/// Read the reviewer's verdict. `round` and `at` are the pipeline's own; the
/// commit is the reviewer's claim and is checked by the caller.
pub fn review(message: &str, round: u32, at: &str) -> Result<Verdict, ReviewError> {
    let block = last_block(message, REVIEW_FENCE).ok_or(ReviewError::Missing)?;
    let value: Value = serde_json::from_str(&block).map_err(|error| ReviewError::Unreadable(format!("the review block is not JSON: {error}")))?;
    let said = text_field(&value, &["verdict", "decision"]).unwrap_or_default().to_ascii_lowercase();
    if said == "pending" {
        return Err(ReviewError::Pending(text_field(&value, &["reason", "checksNote", "checks_note"])));
    }
    let commit = text_field(&value, &["commit"]).ok_or_else(|| ReviewError::Unreadable("the review block names no commit".into()))?;
    let decision = match said.as_str() {
        "merge" | "approve" | "approved" => Decision::Merge,
        "changes" | "changes_requested" | "request_changes" => Decision::Changes,
        other => return Err(ReviewError::Unreadable(format!("the verdict must be \"merge\" or \"changes\", not {other:?}"))),
    };
    let findings: Vec<Finding> = match value.get("findings") {
        None | Some(Value::Null) => Vec::new(),
        Some(list) => serde_json::from_value(list.clone()).map_err(|error| ReviewError::Unreadable(format!("the findings are not readable: {error}")))?,
    };
    let security_pass = match text_field(&value, &["securityPass", "security_pass", "security"]).unwrap_or_default().to_ascii_lowercase().replace('-', "_").as_str() {
        "clean" | "passed" => SecurityPass::Clean,
        "flagged" => SecurityPass::Flagged,
        _ => SecurityPass::NotNeeded,
    };
    // A finding marked as a security finding means the pass flagged something,
    // whatever the summary field says.
    let security_pass = if findings.iter().any(|finding| finding.security) { SecurityPass::Flagged } else { security_pass };
    let checks = Some(ReviewChecks::parse(text_field(&value, &["checks"]).as_deref()));
    let checks_note = text_field(&value, &["checksNote", "checks_note", "checksReason"]);
    Ok(Verdict { commit, decision, security_pass, findings, checks, checks_note, round, at: at.to_string() })
}

fn location(finding: &Finding) -> String {
    match (finding.file.as_deref(), finding.line) {
        (Some(file), Some(line)) => format!(" (`{file}:{line}`)"),
        (Some(file), None) => format!(" (`{file}`)"),
        _ => String::new(),
    }
}

/// The findings as a list, worst first: what goes on the pull request and
/// back to the author.
pub fn findings_markdown(findings: &[Finding]) -> String {
    let mut ordered: Vec<&Finding> = findings.iter().collect();
    ordered.sort_by_key(|finding| std::cmp::Reverse(finding.severity));
    ordered
        .iter()
        .map(|finding| {
            let tag = if finding.security { format!("{}, security", finding.severity.label()) } else { finding.severity.label().to_string() };
            let detail = finding.detail.as_deref().map(str::trim).filter(|detail| !detail.is_empty()).map(|detail| format!("\n  {}", detail.replace('\n', "\n  "))).unwrap_or_default();
            format!("- **[{tag}]** {}{}{detail}", finding.title.trim(), location(finding))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The comment TerminalX leaves on the pull request for one review.
pub fn review_comment(verdict: &Verdict, max_rounds: u32, mergeable: bool) -> String {
    let short = verdict.commit.chars().take(10).collect::<String>();
    let headline = if mergeable { "no blocking findings" } else { "changes requested" };
    let mut body = format!("### TerminalX review of `{short}` — {headline}\n\nRound {} of {max_rounds}, by a reviewer session that did not write this change.", verdict.round);
    match verdict.security_pass {
        SecurityPass::NotNeeded => {}
        SecurityPass::Clean => body.push_str(" Security pass: clean."),
        SecurityPass::Flagged => body.push_str(" Security pass: flagged."),
    }
    if let Some(checks) = verdict.checks_line() {
        body.push(' ');
        body.push_str(&checks);
    }
    if verdict.findings.is_empty() {
        body.push_str("\n\nNo findings.");
    } else {
        body.push_str("\n\n");
        body.push_str(&findings_markdown(&verdict.findings));
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_author_report_is_the_last_status_block_and_nothing_else() {
        let reply = "Fixed the timeout.\n\n```terminalx-status\n{\"status\":\"blocked\",\"reason\":\"old\"}\n```\n\nActually done now.\n\n```terminalx-status\n{\"status\": \"done\", \"checks\": \"passed\", \"summary\": \"Retry the login once.\"}\n```\n";
        assert_eq!(author_report(reply), AuthorReport::Done { checks: LocalChecks::Passed, summary: Some("Retry the login once.".into()) });
        // Prose that sounds finished is not a report.
        assert_eq!(author_report("All done, tests pass!"), AuthorReport::Missing);
        assert_eq!(author_report("```json\n{\"status\":\"done\"}\n```"), AuthorReport::Missing);
        assert_eq!(author_report("```terminalx-status\nnot json\n```"), AuthorReport::Missing);
        assert_eq!(author_report("```terminalx-status\n{\"status\":\"blocked\",\"reason\":\"Which database?\"}\n```"), AuthorReport::NotDone { reason: Some("Which database?".into()) });
    }

    #[test]
    fn local_checks_pass_only_when_the_author_says_so() {
        let report = |checks: &str| author_report(&format!("```terminalx-status\n{{\"status\":\"done\",\"checks\":\"{checks}\"}}\n```"));
        assert_eq!(report("passed"), AuthorReport::Done { checks: LocalChecks::Passed, summary: None });
        assert_eq!(report("none"), AuthorReport::Done { checks: LocalChecks::None, summary: None });
        for not_a_pass in ["failed", "not_run", "", "mostly"] {
            assert_eq!(report(not_a_pass), AuthorReport::Done { checks: LocalChecks::Failed, summary: None }, "{not_a_pass}");
        }
        assert_eq!(author_report("```terminalx-status\n{\"status\":\"done\"}\n```"), AuthorReport::Done { checks: LocalChecks::Failed, summary: None });
    }

    #[test]
    fn a_review_reads_its_commit_verdict_and_findings() {
        let reply = "I read the diff.\n\n```terminalx-review\n{\"commit\":\"abc1234def\",\"verdict\":\"changes\",\"securityPass\":\"clean\",\"findings\":[{\"severity\":\"high\",\"title\":\"Token is logged\",\"file\":\"src/auth.rs\",\"line\":42,\"detail\":\"The bearer token reaches the log.\"},{\"severity\":\"nit\",\"title\":\"Typo\"}]}\n```";
        let verdict = review(reply, 2, "now").unwrap();
        assert_eq!(verdict.commit, "abc1234def");
        assert_eq!(verdict.decision, Decision::Changes);
        assert_eq!(verdict.security_pass, SecurityPass::Clean);
        assert_eq!(verdict.round, 2);
        assert_eq!(verdict.findings.len(), 2);
        assert_eq!(verdict.findings[0].severity, Severity::High);
        assert_eq!(verdict.findings[0].line, Some(42));
        assert_eq!(verdict.blocking().count(), 1);
        assert!(!verdict.security_flagged());
    }

    #[test]
    fn a_reply_without_a_usable_review_block_is_not_a_verdict() {
        assert_eq!(review("Looks good to me, merge it.", 1, "now"), Err(ReviewError::Missing));
        assert!(matches!(review("```terminalx-review\n{oops\n```", 1, "now"), Err(ReviewError::Unreadable(_))));
        assert!(matches!(review("```terminalx-review\n{\"verdict\":\"merge\"}\n```", 1, "now"), Err(ReviewError::Unreadable(_))));
        assert!(matches!(review("```terminalx-review\n{\"commit\":\"abc1234\",\"verdict\":\"ship it\"}\n```", 1, "now"), Err(ReviewError::Unreadable(_))));
        assert!(matches!(review("```terminalx-review\n{\"commit\":\"abc1234\",\"verdict\":\"merge\",\"findings\":\"none\"}\n```", 1, "now"), Err(ReviewError::Unreadable(_))));
        // An unterminated block is not a block.
        assert_eq!(review("```terminalx-review\n{\"commit\":\"abc1234\",\"verdict\":\"merge\"}", 1, "now"), Err(ReviewError::Missing));
    }

    #[test]
    fn backticks_in_a_finding_do_not_end_the_block_and_a_quoted_block_is_not_a_report() {
        // A finding that quotes a fenced snippet in its detail: still one block, read whole.
        let quoting = "```terminalx-review\n{\"commit\":\"abc1234\",\"verdict\":\"changes\",\"findings\":[{\"severity\":\"high\",\"title\":\"Bad fence\",\"detail\":\"Uses ```js without closing it\"}]}\n```";
        let verdict = review(quoting, 1, "now").unwrap();
        assert_eq!(verdict.findings[0].detail.as_deref(), Some("Uses ```js without closing it"));
        // Pretty-printed over several lines reads the same.
        let spread = "```terminalx-review\n{\n  \"commit\": \"abc1234\",\n  \"verdict\": \"merge\",\n  \"findings\": []\n}\n```\n";
        assert_eq!(review(spread, 1, "now").unwrap().decision, Decision::Merge);
        // The instructions quoted back inside another block are not the reviewer's verdict,
        let quoted = "You asked me to end with:\n\n```markdown\n```terminalx-review\n{\"commit\":\"abc1234\",\"verdict\":\"merge\"}\n```\n```\n\nI have not finished reading yet.";
        assert_eq!(review(quoted, 1, "now"), Err(ReviewError::Missing));
        // nor is the author's status block when it is only being shown as an example.
        assert_eq!(author_report("For example:\n\n```text\n```terminalx-status\n{\"status\":\"done\",\"checks\":\"passed\"}\n```\n```"), AuthorReport::Missing);
        // A fence with trailing spaces or indentation still opens and closes.
        assert!(matches!(author_report("  ```terminalx-status  \n{\"status\":\"done\",\"checks\":\"passed\"}\n  ```  "), AuthorReport::Done { .. }));
    }

    #[test]
    fn an_unknown_severity_blocks_and_a_security_finding_flags_the_pass() {
        let reply = "```terminalx-review\n{\"commit\":\"abc1234\",\"verdict\":\"merge\",\"findings\":[{\"severity\":\"serious\",\"title\":\"x\"},{\"severity\":\"low\",\"title\":\"y\",\"security\":true}]}\n```";
        let verdict = review(reply, 1, "now").unwrap();
        assert_eq!(verdict.findings[0].severity, Severity::Medium);
        assert_eq!(verdict.security_pass, SecurityPass::Flagged);
        assert!(verdict.security_flagged());
        assert!(Severity::Nit < Severity::Low && Severity::Low < Severity::Medium && Severity::Medium < Severity::High && Severity::High < Severity::Critical);
    }

    #[test]
    fn findings_are_listed_worst_first_with_their_place() {
        let findings = vec![
            Finding { severity: Severity::Low, title: "Rename".into(), detail: None, file: Some("a.rs".into()), line: None, security: false },
            Finding { severity: Severity::Critical, title: "Deletes the wrong rows".into(), detail: Some("No tenant filter.\nSee the query.".into()), file: Some("db.rs".into()), line: Some(9), security: true },
        ];
        assert_eq!(
            findings_markdown(&findings),
            "- **[critical, security]** Deletes the wrong rows (`db.rs:9`)\n  No tenant filter.\n  See the query.\n- **[low]** Rename (`a.rs`)"
        );
        let verdict = Verdict { commit: "abc1234def5678".into(), decision: Decision::Changes, security_pass: SecurityPass::Flagged, findings, checks: None, checks_note: None, round: 1, at: "now".into() };
        let comment = review_comment(&verdict, 3, false);
        assert!(comment.starts_with("### TerminalX review of `abc1234def` — changes requested"));
        assert!(comment.contains("Round 1 of 3"));
        assert!(comment.contains("Security pass: flagged."));
        // A verdict stored before reviews said what their checks came to says nothing about them.
        assert!(!comment.contains("checks") && !comment.contains("tests"));
        let clean = Verdict { findings: Vec::new(), decision: Decision::Merge, security_pass: SecurityPass::NotNeeded, ..verdict };
        assert!(review_comment(&clean, 3, true).ends_with("No findings."));
    }

    #[test]
    fn a_review_says_whether_its_checks_ran_and_only_an_explicit_pass_is_one() {
        let said = |checks: &str| review(&format!("```terminalx-review\n{{\"commit\":\"abc1234\",\"verdict\":\"merge\",{checks}\"findings\":[]}}\n```"), 1, "now").unwrap();
        let passed = said(r#""checks":"passed","checksNote":"cargo test: 212 passed","#);
        assert_eq!((passed.checks, passed.checks_note.as_deref()), (Some(ReviewChecks::Passed), Some("cargo test: 212 passed")));
        assert_eq!(said(r#""checks":"failed","#).checks, Some(ReviewChecks::Failed));
        for not_run in [r#""checks":"not_run","#, r#""checks":"mostly","#, r#""checks":"","#, ""] {
            assert_eq!(said(not_run).checks, Some(ReviewChecks::NotRun), "{not_run}");
        }
        // Said in the record and on the pull request.
        let reading = said(r#""checks":"not_run","checksNote":"the build waits on a file lock.","#);
        assert_eq!(reading.checks_line().as_deref(), Some("Reviewed by reading only, tests not run: the build waits on a file lock."));
        assert!(!review_comment(&reading, 3, true).contains("Security pass") && review_comment(&reading, 3, true).contains("Reviewed by reading only, tests not run: the build waits on a file lock."));
        assert_eq!(said(r#""checks":"failed","#).checks_line().as_deref(), Some("The reviewer's checks failed."));
        assert_eq!(passed.checks_line().as_deref(), Some("The reviewer's checks passed: cargo test: 212 passed."));
        // Kept to one short line of its sentence.
        let spread = Verdict { checks_note: Some("cargo test\n\n  ran   ok".into()), ..passed.clone() };
        assert_eq!(spread.checks_line().as_deref(), Some("The reviewer's checks passed: cargo test ran ok."));
        let long = Verdict { checks_note: Some("x".repeat(500)), ..passed.clone() };
        assert_eq!(long.checks_line().unwrap().chars().count(), "The reviewer's checks passed: ".len() + CHECKS_NOTE_LIMIT + "….".chars().count());
        // Stored, it reads back as written, and a verdict stored before it is still read.
        let stored = serde_json::to_value(&reading).unwrap();
        assert_eq!((stored["checks"].as_str(), stored["checksNote"].as_str()), (Some("notRun"), Some("the build waits on a file lock.")));
        let legacy: Verdict = serde_json::from_value(serde_json::json!({"commit":"abc1234","decision":"merge","securityPass":"notNeeded","findings":[],"round":1,"at":"now"})).unwrap();
        assert_eq!(legacy.checks, None);
    }

    #[test]
    fn a_pending_review_is_not_a_verdict_and_says_what_is_still_running() {
        let pending = "Tests are compiling.\n\n```terminalx-review\n{\"commit\":\"abc1234\",\"verdict\":\"pending\",\"reason\":\"cargo test is still compiling\"}\n```";
        assert_eq!(review(pending, 1, "now"), Err(ReviewError::Pending(Some("cargo test is still compiling".into()))));
        // The commit is not needed to say so, nor a reason.
        assert_eq!(review("```terminalx-review\n{\"verdict\":\"Pending\"}\n```", 1, "now"), Err(ReviewError::Pending(None)));
        // A verdict after it, in the same reply, is the one that counts.
        let then = format!("{pending}\n\nDone now.\n\n```terminalx-review\n{{\"commit\":\"abc1234\",\"verdict\":\"merge\",\"checks\":\"passed\"}}\n```");
        assert_eq!(review(&then, 1, "now").unwrap().checks, Some(ReviewChecks::Passed));
    }
}
