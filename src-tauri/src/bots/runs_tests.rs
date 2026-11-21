//! PRO-476: the parts of a bot's runs that need no dispatch. The flows are in
//! `control_bot_runs_tests.rs`.

use super::*;
use crate::bots::items::{ItemState, Question};

fn item_with_run(run: &str) -> Item {
    serde_json::from_value(json!({
        "number": 3, "title": "Runner move", "state": "needsYou", "askedBy": "owner", "addedBy": "b1", "created": "now", "modified": "now",
        "runs": [{"run": run, "asked": "now", "minutes": 40}],
    }))
    .unwrap()
}

fn question(purpose: &str, run: &str) -> Question {
    Question { id: "q".into(), text: RUN_QUESTION.into(), answers: RUN_ANSWERS.iter().map(|answer| answer.to_string()).collect(), recommended: Some(0), asked: "now".into(), purpose: purpose.into(), run: run.into(), unknown: Default::default() }
}

#[test]
fn a_check_back_is_a_time_a_report_or_off() {
    let time = check_back("2026-11-21T13:40:00+01:00", Some("chat".into())).unwrap().unwrap();
    assert_eq!((time.at.as_deref(), time.on_report, time.session.as_deref()), (Some("2026-11-21T12:40:00+00:00"), true, Some("chat")));
    let report = check_back("report", None).unwrap().unwrap();
    assert_eq!((report.at.as_deref(), report.on_report), (None, true));
    assert_eq!(check_back("off", None).unwrap(), None);
    assert!(check_back("at noon", None).is_err());
    let now: DateTime<Utc> = "2026-11-21T12:40:00Z".parse().unwrap();
    assert!(due(&time, now) && !due(&report, now));
    assert!(!due(&time, "2026-11-21T12:39:59Z".parse().unwrap()));
}

#[test]
fn the_app_acts_on_the_answers_number_never_its_words() {
    for (answer, decision, hold, approved) in [(Answer::Choice(0), "start", false, true), (Answer::Choice(1), "startAskMerge", true, true), (Answer::Choice(2), "notNow", false, false), (Answer::Typed("Approve it".into()), "answered", false, false)] {
        let mut item = item_with_run("r1");
        answered(&mut item, &question(PURPOSE_START_RUN, "r1"), &answer);
        assert_eq!((item.runs[0].decision.as_str(), item.runs[0].hold_merge), (decision, hold), "{answer:?}");
        assert_eq!(item.activity.iter().any(|entry| entry.kind == "approved"), approved, "{answer:?}: typed words never approve");
    }
    // A merge: only Merge lets it go.
    let mut item = item_with_run("r1");
    item.runs[0].hold_merge = true;
    answered(&mut item, &question(PURPOSE_MERGE_RUN, "r1"), &Answer::Choice(1));
    assert!(item.runs[0].merge_approved.is_none());
    answered(&mut item, &question(PURPOSE_MERGE_RUN, "r1"), &Answer::Choice(0));
    assert!(item.runs[0].merge_approved.is_some());
    // An ordinary question, or another run's, changes no run.
    let mut item = item_with_run("r1");
    answered(&mut item, &question("", ""), &Answer::Choice(0));
    answered(&mut item, &question(PURPOSE_START_RUN, "r2"), &Answer::Choice(0));
    assert_eq!((item.runs[0].decision.as_str(), item.state), ("", ItemState::NeedsYou));
}

#[test]
fn a_wake_note_carries_no_words_of_a_bot_or_a_worker() {
    let time = wake_text(14, &Why::Time(Utc::now()));
    assert!(time.contains("item #14") && time.contains("terminalx bots items show 14"));
    let report = wake_text(14, &Why::Report { run: "r1", lead: "s" });
    assert!(report.contains("Run r1 told its lead something new") && report.contains("terminalx runs show r1"));
}

#[test]
fn an_item_from_an_older_build_reads_with_no_runs_and_keeps_what_a_newer_one_wrote() {
    let item: Item = serde_json::from_value(json!({"number": 1, "title": "T", "created": "now", "modified": "now", "runs": [{"run": "r", "asked": "now", "later": 1}], "checkBack": {"onReport": true, "later": 2}})).unwrap();
    let saved = serde_json::to_value(&item).unwrap();
    assert_eq!((saved["runs"][0]["later"].as_u64(), saved["checkBack"]["later"].as_u64()), (Some(1), Some(2)));
    let older: Item = serde_json::from_value(json!({"number": 2, "title": "T", "created": "now", "modified": "now"})).unwrap();
    assert!(older.runs.is_empty() && older.check_back.is_none());
    assert!(serde_json::to_value(&older).unwrap().get("runs").is_none());
}
