use super::*;
use serde_json::{json, Value};

const PR: &str = "https://github.com/terminalx-ai/terminalx/pull/809";
const RUN: &str = "https://github.com/terminalx-ai/terminalx/actions/runs/42294938164";
// Recorded with gh run view 42294938164 --repo terminalx-ai/terminalx
// --json jobs / --log-failed on 2026-11-07. The log fixture retains only a
// failure excerpt, excluding environment/setup output; job metadata is projected.
const RECORDED_LOG: &str = include_str!("fixtures/failed-output.txt");

#[test]
fn maps_recorded_actions_job_urls_without_confusing_run_and_job_ids() {
    let recorded: Value = serde_json::from_str(include_str!("fixtures/run-jobs.json")).unwrap();
    for job in recorded["jobs"].as_array().unwrap() {
        assert_eq!(map_check(PR, job["url"].as_str().unwrap()), Some(ActionsCheck {
            run_id: 42294938164, job_id: job["databaseId"].as_u64(),
        }));
    }
    assert_eq!(map_check(PR, RUN), Some(ActionsCheck { run_id: 42294938164, job_id: None }));
    assert_eq!(map_check(PR, &format!("{RUN}/attempts/2/job/90?check_suite_focus=true#step:1")), Some(ActionsCheck { run_id: 42294938164, job_id: Some(90) }));
    assert_eq!(map_check(PR, &format!("{RUN}/attempts/2")), Some(ActionsCheck { run_id: 42294938164, job_id: None }));
    assert_eq!(map_check("https://git.example.com/team/repo/pull/1", "https://git.example.com/team/repo/actions/runs/123/job/456").unwrap().run_id, 123);
}

#[test]
fn rejects_foreign_ci_malformed_urls_and_legacy_job_ids_as_runs() {
    for url in [
        "https://circleci.com/terminalx-ai/terminalx/actions/runs/123",
        "https://github.com/other/repo/actions/runs/123",
        "https://github.com.evil.test/terminalx-ai/terminalx/actions/runs/123",
        "http://github.com/terminalx-ai/terminalx/actions/runs/123",
        "https://user@github.com/terminalx-ai/terminalx/actions/runs/123",
        "https://github.com/terminalx-ai/terminalx/actions/runs/0",
        "https://github.com/terminalx-ai/terminalx/actions/runs/--help",
        "https://github.com/terminalx-ai/terminalx/actions/runs/123/job/0",
        "https://github.com/terminalx-ai/terminalx/actions/runs/123/unexpected",
        "https://github.com/terminalx-ai/terminalx/runs/456?check_suite_focus=true",
    ] {
        assert_eq!(map_check(PR, url), None, "{url}");
    }
    assert!(map_check("not a PR URL", RUN).is_none());
}

#[test]
fn commands_pin_repository_and_rerun_the_workflow_not_the_job() {
    let check_url = format!("{RUN}/job/128157610557");
    let check = map_check(PR, &check_url).unwrap();
    assert_eq!(log_args(&repository(PR).unwrap(), &check, true), ["run", "view", "42294938164", "--repo", "github.com/terminalx-ai/terminalx", "--log-failed", "--job", "128157610557"]);
    for failed in [true, false] {
        rerun_with(Path::new("."), PR, &check_url, failed, |_, args| {
            let mut expected = vec!["run", "rerun", "42294938164", "--repo", "github.com/terminalx-ai/terminalx"];
            if failed { expected.push("--failed"); }
            assert_eq!(args, expected);
            Ok(String::new())
        }).unwrap();
    }
    assert!(rerun_with(Path::new("."), PR, RUN, true, |_, _| bail!("not authorized")).unwrap_err().to_string().contains("not authorized"));
    assert!(rerun_with(Path::new("."), PR, "https://ci.example.com/build/1", true, |_, _| unreachable!()).is_err());
    assert_eq!(repository("https://git.example.com:8443/team/repo/pull/1").unwrap(), "git.example.com:8443/team/repo");
}

#[cfg(unix)]
#[test]
fn a_helper_retaining_log_pipes_cannot_hold_the_viewer_forever() {
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", "sleep 30 & exit 0"]);
    let start = std::time::Instant::now();
    assert!(log_output(command, std::time::Duration::from_millis(200)).unwrap_err().to_string().contains("Timed out"));
    assert!(start.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn trims_recorded_output_to_a_hard_byte_limit_and_keeps_the_failure_tail() {
    assert_eq!(trim_log(RECORDED_LOG, LOG_LIMIT).text, RECORDED_LOG);
    assert!(!trim_log(RECORDED_LOG, LOG_LIMIT).truncated);
    let long = format!("{}{}", "setup\n".repeat(LOG_LIMIT), RECORDED_LOG);
    let trimmed = trim_log(&long, LOG_LIMIT);
    assert!(trimmed.truncated);
    assert!(trimmed.text.starts_with(TRIMMED));
    assert!(trimmed.text.ends_with(RECORDED_LOG));
    assert!(trimmed.text.len() <= LOG_LIMIT);
    let streamed = read_tail(long.as_bytes(), LOG_LIMIT).unwrap();
    assert!(streamed.truncated);
    assert_eq!(streamed.text, trimmed.text);
    for limit in 0..100 {
        let unicode = trim_log(&"é🙂失敗".repeat(100), limit);
        assert!(unicode.text.len() <= limit);
    }
    let invalid = read_tail(&[255u8; 100][..], 64).unwrap();
    assert!(invalid.text.len() <= 64);
    assert!(invalid.truncated);
}

#[test]
fn all_failed_runs_share_one_attachment_budget_and_each_run_is_loaded_once() {
    let mut pr = super::super::parse_pr(&json!({ "url": PR, "statusCheckRollup": [
        { "name": "test", "conclusion": "FAILURE", "detailsUrl": format!("{RUN}/job/1") },
        { "name": "lint", "conclusion": "FAILURE", "detailsUrl": format!("{RUN}/job/2") },
        { "name": "other", "conclusion": "FAILURE", "detailsUrl": "https://github.com/terminalx-ai/terminalx/actions/runs/22/job/3" },
        { "name": "external", "state": "FAILURE", "targetUrl": "https://ci.example.com/4" },
        { "name": "pass", "conclusion": "SUCCESS", "detailsUrl": "https://github.com/terminalx-ai/terminalx/actions/runs/33/job/4" }
    ] }));
    assert_eq!(pr.checks[0].actions, Some(ActionsCheck { run_id: 42294938164, job_id: Some(1) }));
    assert!(pr.checks[3].actions.is_none());
    let mut loaded = Vec::new();
    let log = collect_failed_logs(&pr, |check| {
        loaded.push(check.run_id);
        assert!(check.job_id.is_none());
        Ok(CheckLog { text: RECORDED_LOG.repeat(200), truncated: false })
    }).unwrap();
    assert_eq!(loaded, [22, 42294938164]);
    assert!(log.truncated);
    assert!(log.text.len() <= LOG_LIMIT);
    for id in loaded { assert!(log.text.contains(&format!("=== Actions run {id} ==="))); }
    assert!(collect_failed_logs(&pr, |_| bail!("log expired")).is_err());
    let empty = collect_failed_logs(&pr, |_| Ok(CheckLog { text: String::new(), truncated: false })).unwrap();
    assert!(empty.text.contains("No failed step log output was returned"));
    assert!(empty.text.contains(RUN));
    pr.checks.clear();
    assert!(collect_failed_logs(&pr, |_| unreachable!()).is_err());
}
