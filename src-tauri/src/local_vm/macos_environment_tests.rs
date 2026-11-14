//! The production entry's refusal order. The verified mapping, retries and
//! collisions run against the compiled owner fixture in
//! `macos_owner_launch_tests.rs`, where the real version-3 key, grant and pin
//! records are produced.
use super::*;

#[test]
fn production_binding_refuses_before_reading_or_writing_anything() {
    // Transport admission refuses first: no root, journal or record is read.
    let error = bind(&json!({"idempotencyKey": journal::new_id(), "name": "Personal Mac"})).unwrap_err();
    assert!(format!("{error:#}").contains("unavailable"), "{error:#}");
    // And no build-time or request digest stands in for an approved runtime.
    let error = ApprovedRuntime::production().err().unwrap();
    assert!(format!("{error:#}").contains("No approved guest runtime"), "{error:#}");
}
