use super::*;

#[test]
fn a_bundle_goes_out_in_parts_that_fit_a_frame_and_only_to_its_connection() {
    let encoded = "a".repeat(PART_CHARS * 2 + 10);
    let started = hold_out("device-1", encoded.clone()).unwrap();
    assert_eq!(started["parts"], 3);
    let id = started["transfer"].as_str().unwrap().to_string();
    let held = transfers();
    let transfer = held.get(&id).unwrap();
    assert_eq!(transfer.device, "device-1");
    assert!(transfer.parts.iter().flatten().all(|part| part.len() <= PART_CHARS));
    assert_eq!(transfer.parts.iter().flatten().cloned().collect::<String>(), encoded);
    const { assert!(PART_CHARS * 3 < super::super::server::MAX_FRAME_BYTES, "a part fits a frame with room for its encoding") };
}

#[test]
fn ids_are_checked() {
    assert!(transfer_id(&serde_json::json!({"transfer": "../x"})).is_err());
    assert!(transfer_id(&serde_json::json!({"transfer": "a".repeat(65)})).is_err());
    assert_eq!(transfer_id(&serde_json::json!({"transfer": "ab-12"})).unwrap(), "ab-12");
}
